create extension if not exists pgcrypto;

create or replace function public.numeric_or_null(p_value text)
returns numeric language sql immutable
as $$
  select case when coalesce(p_value, '') ~ '^-?[0-9]+(\.[0-9]+)?$' then p_value::numeric else null end;
$$;
revoke all on function public.numeric_or_null(text) from public, anon, authenticated;

create table if not exists public.businesses (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'My business',
  created_at timestamptz not null default now()
);

create table if not exists public.business_memberships (
  business_id uuid not null references public.businesses(id) on delete cascade,
  user_id uuid not null,
  role text not null default 'owner' check (role in ('owner','reviewer','employee')),
  created_at timestamptz not null default now(),
  primary key (business_id, user_id)
);
create index if not exists business_memberships_user_id_idx on public.business_memberships(user_id);

create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  uploaded_by uuid not null,
  original_filename text not null,
  workflow text not null check (workflow in ('purchasing','claim')),
  route_mode text not null default 'manual' check (route_mode in ('manual','automatic')),
  purpose text not null default '',
  status text not null default 'queued',
  sha256 text not null,
  storage_key text not null unique,
  mime_type text not null default 'application/octet-stream',
  idempotency_key text,
  linked_po_document_id uuid references public.documents(id),
  input_version integer not null default 1 check (input_version > 0),
  manual_overrides jsonb not null default '{}'::jsonb,
  manual_override_metadata jsonb not null default '{}'::jsonb,
  analysis jsonb,
  findings jsonb not null default '[]'::jsonb,
  approved_by uuid,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, idempotency_key)
);
create index if not exists documents_business_created_idx on public.documents(business_id, created_at desc);
create index if not exists documents_business_sha256_idx on public.documents(business_id, sha256);
alter table public.documents add column if not exists route_mode text not null default 'manual' check (route_mode in ('manual','automatic'));

create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  document_id uuid not null references public.documents(id) on delete cascade,
  status text not null default 'queued',
  error jsonb,
  lease_owner uuid,
  lease_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (business_id, document_id)
);
create index if not exists jobs_business_created_idx on public.jobs(business_id, created_at desc);
create index if not exists jobs_recovery_idx on public.jobs(status, lease_expires_at);

create table if not exists public.issues (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  job_id uuid not null references public.jobs(id) on delete cascade,
  document_id uuid not null references public.documents(id) on delete cascade,
  stable_key text not null,
  code text not null,
  severity text not null default 'warning' check (severity in ('info','warning','error')),
  status text not null default 'open' check (status in ('open','needs_review','resolved')),
  message text not null,
  source_refs jsonb not null default '[]'::jsonb,
  expected jsonb,
  observed jsonb,
  resolved_by uuid,
  resolution_reason text,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  unique (business_id, stable_key)
);
create index if not exists issues_business_status_idx on public.issues(business_id, status, created_at desc);

create table if not exists public.job_events (
  event_id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  job_id uuid not null references public.jobs(id) on delete cascade,
  type text not null default 'agent_progress',
  agent text,
  state text,
  summary text not null default '',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists job_events_job_created_idx on public.job_events(business_id, job_id, created_at);

create table if not exists public.corrections (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  document_id uuid not null references public.documents(id) on delete cascade,
  actor_id uuid not null,
  field text not null,
  value jsonb,
  reason text not null,
  input_version integer not null,
  created_at timestamptz not null default now()
);

create table if not exists public.business_master_data (
  business_id uuid primary key references public.businesses(id) on delete cascade,
  chart_of_accounts jsonb not null default '[]'::jsonb,
  suppliers jsonb not null default '[]'::jsonb,
  buyer_profile jsonb,
  updated_at timestamptz not null default now()
);

alter table public.businesses enable row level security;
alter table public.business_memberships enable row level security;
alter table public.documents enable row level security;
alter table public.jobs enable row level security;
alter table public.issues enable row level security;
alter table public.job_events enable row level security;
alter table public.corrections enable row level security;
alter table public.business_master_data enable row level security;

grant usage on schema public to service_role;
grant all on public.businesses, public.business_memberships, public.documents, public.jobs, public.issues,
  public.job_events, public.corrections, public.business_master_data to service_role;

create policy "members can read their businesses" on public.businesses for select to authenticated
  using (exists (select 1 from public.business_memberships m where m.business_id = id and m.user_id = auth.uid()));
create policy "users can read their own memberships" on public.business_memberships for select to authenticated
  using (user_id = auth.uid());
create policy "business members can read documents" on public.documents for select to authenticated
  using (exists (select 1 from public.business_memberships m where m.business_id = documents.business_id and m.user_id = auth.uid()
    and (m.role in ('owner','reviewer') or (documents.workflow='claim' and documents.uploaded_by=auth.uid()))));
create policy "business members can read jobs" on public.jobs for select to authenticated
  using (exists (select 1 from public.business_memberships m join public.documents d on d.business_id=m.business_id and d.id=jobs.document_id
    where m.business_id = jobs.business_id and m.user_id = auth.uid()
      and (m.role in ('owner','reviewer') or (d.workflow='claim' and d.uploaded_by=auth.uid()))));
create policy "business members can read issues" on public.issues for select to authenticated
  using (exists (select 1 from public.business_memberships m join public.documents d on d.business_id=m.business_id and d.id=issues.document_id
    where m.business_id = issues.business_id and m.user_id = auth.uid()
      and (m.role in ('owner','reviewer') or (d.workflow='claim' and d.uploaded_by=auth.uid()))));
create policy "business members can read events" on public.job_events for select to authenticated
  using (exists (select 1 from public.business_memberships m join public.documents d on d.business_id=m.business_id
      join public.jobs j on j.business_id=d.business_id and j.document_id=d.id and j.id=job_events.job_id
    where m.business_id = job_events.business_id and m.user_id = auth.uid()
      and (m.role in ('owner','reviewer') or (d.workflow='claim' and d.uploaded_by=auth.uid()))));
create policy "business members can read correction history" on public.corrections for select to authenticated
  using (exists (select 1 from public.business_memberships m join public.documents d on d.business_id=m.business_id and d.id=corrections.document_id
    where m.business_id = corrections.business_id and m.user_id = auth.uid()
      and (m.role in ('owner','reviewer') or (d.workflow='claim' and d.uploaded_by=auth.uid()))));
create policy "business members can read their master data" on public.business_master_data for select to authenticated
  using (exists (select 1 from public.business_memberships m where m.business_id = business_master_data.business_id and m.user_id = auth.uid()));

create or replace function public.resolve_business_for_user(p_user_id uuid, p_email text)
returns table(business_id uuid, role text)
language plpgsql security definer set search_path = public
as $$
declare v_business uuid; v_role text;
begin
  select m.business_id, m.role into v_business, v_role from public.business_memberships m where m.user_id = p_user_id order by m.created_at limit 1;
  if v_business is null then
    insert into public.businesses(name) values (coalesce(nullif(split_part(p_email, '@', 1), ''), 'My business')) returning id into v_business;
    insert into public.business_memberships(business_id, user_id, role) values (v_business, p_user_id, 'owner');
    v_role := 'owner';
  end if;
  return query select v_business, v_role;
end;
$$;
revoke all on function public.resolve_business_for_user(uuid,text) from public, anon, authenticated;
grant execute on function public.resolve_business_for_user(uuid,text) to service_role;

create or replace function public.claim_intake_job(p_business_id uuid, p_job_id uuid, p_worker_id uuid, p_lease_seconds integer default 900)
returns boolean language plpgsql security definer set search_path = public
as $$
declare v_count integer;
begin
  update public.jobs set status='processing', lease_owner=p_worker_id,
      lease_expires_at=now()+make_interval(secs => greatest(1,least(p_lease_seconds,1800))), updated_at=now()
    where id=p_job_id and business_id=p_business_id
      and (status='queued' or (status='processing' and (lease_expires_at is null or lease_expires_at < now())));
  get diagnostics v_count = row_count;
  if v_count = 1 then
    insert into public.job_events(business_id,job_id,type,agent,state,summary,payload)
      values (p_business_id,p_job_id,'job','workflow','processing','Document processor claimed this job.',jsonb_build_object('workerId',p_worker_id));
  end if;
  return v_count = 1;
end;
$$;
revoke all on function public.claim_intake_job(uuid,uuid,uuid,integer) from public, anon, authenticated;
grant execute on function public.claim_intake_job(uuid,uuid,uuid,integer) to service_role;

create or replace function public.renew_intake_job_lease(p_business_id uuid, p_job_id uuid, p_worker_id uuid, p_lease_seconds integer default 900)
returns boolean language plpgsql security definer set search_path = public
as $$
declare v_count integer;
begin
  update public.jobs set lease_expires_at=now()+make_interval(secs => greatest(1,least(p_lease_seconds,1800))), updated_at=now()
    where id=p_job_id and business_id=p_business_id and lease_owner=p_worker_id and status='processing';
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;
revoke all on function public.renew_intake_job_lease(uuid,uuid,uuid,integer) from public, anon, authenticated;
grant execute on function public.renew_intake_job_lease(uuid,uuid,uuid,integer) to service_role;

create or replace function public.persist_document_proposal(p_business_id uuid, p_job_id uuid, p_document_id uuid, p_result jsonb)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare
  v_finding jsonb;
  v_key text;
  v_status text;
  v_po_document_id uuid;
  v_po public.documents;
  v_document jsonb;
  v_result jsonb;
  v_line record;
  v_item text;
  v_allowed numeric;
  v_used numeric;
  v_po_total numeric;
  v_existing_total numeric;
  v_current_total numeric;
  v_issue_refs jsonb;
  v_current_line_total numeric;
  v_quantity_code text;
  v_quantity_stable_key text;
  v_workflow text;
begin
  if not exists (select 1 from public.jobs j where j.id = p_job_id and j.business_id = p_business_id and j.document_id = p_document_id)
     or not exists (select 1 from public.documents d where d.id = p_document_id and d.business_id = p_business_id) then
    raise exception 'proposal scope mismatch' using errcode = '42501';
  end if;
  v_status := coalesce(p_result->>'status', 'needs_review');
  v_po_document_id := nullif(coalesce(p_result->'document'->>'linkedPoDocumentId', p_result->'analysis'->'document'->>'linkedPoDocumentId'), '')::uuid;
  v_result := p_result;
  v_document := coalesce(v_result->'document', v_result->'analysis'->'document', '{}'::jsonb);
  v_workflow := coalesce(v_result->>'workflow', (select d.workflow from public.documents d where d.id = p_document_id and d.business_id = p_business_id));
  if v_workflow not in ('purchasing','claim') then raise exception 'invalid routed workflow' using errcode='23514'; end if;

  -- Serialize invoice proposals on their PO so parallel jobs see prior committed consumption.
  if v_po_document_id is not null and v_document->>'type' in ('invoice','delivery_order') then
    select * into v_po from public.documents po where po.id = v_po_document_id and po.business_id = p_business_id
      and coalesce(po.analysis->'document'->>'type', '') = 'purchase_order' for update;
    if not found then raise exception 'PO link must reference an existing purchase order in the same business' using errcode='42501'; end if;

    select coalesce(jsonb_agg(jsonb_build_object('documentId', d.id)), '[]'::jsonb)
      into v_issue_refs
      from public.documents d
      where d.business_id = p_business_id and d.linked_po_document_id = v_po_document_id and d.id <> p_document_id
        and coalesce(d.analysis->'document'->>'type', '') = v_document->>'type'
        and d.status not in ('failed','needs_configuration');
    v_issue_refs := jsonb_build_array(jsonb_build_object('documentId', v_po_document_id)) || v_issue_refs || jsonb_build_array(jsonb_build_object('documentId', p_document_id));
    v_quantity_code := case when v_document->>'type' = 'delivery_order' then 'PURCHASE_PO_DELIVERY_QUANTITY_EXCEEDED' else 'PURCHASE_PO_QUANTITY_EXCEEDED' end;
    v_quantity_stable_key := 'purchase-po-quantity:' || v_po_document_id::text || ':' || (v_document->>'type') || ':' || p_document_id::text;

    for v_line in select value from jsonb_array_elements(
      case when jsonb_typeof(v_po.analysis->'document'->'lines') = 'array' then v_po.analysis->'document'->'lines' else '[]'::jsonb end
    ) as po_lines(value)
    loop
      v_item := lower(regexp_replace(coalesce(v_line.value->>'item',''), '[^[:alnum:]]', '', 'g'));
      v_allowed := public.numeric_or_null(v_line.value->>'quantity');
      if v_item <> '' and v_allowed is not null and v_allowed > 0 then
        select coalesce(sum(public.numeric_or_null(invoice_line.line->>'quantity')), 0)
          into v_used
          from (
            select prior_line.value as line
              from public.documents d
              cross join lateral jsonb_array_elements(
                case when jsonb_typeof(d.analysis->'document'->'lines') = 'array' then d.analysis->'document'->'lines' else '[]'::jsonb end
              ) as prior_line(value)
              where d.business_id = p_business_id and d.linked_po_document_id = v_po_document_id and d.id <> p_document_id
                and coalesce(d.analysis->'document'->>'type','') = v_document->>'type'
                and d.status not in ('failed','needs_configuration')
            union all
            select current_line.value as line from jsonb_array_elements(
              case when jsonb_typeof(v_document->'lines') = 'array' then v_document->'lines' else '[]'::jsonb end
            ) as current_line(value)
          ) as invoice_line
          where lower(regexp_replace(coalesce(invoice_line.line->>'item',''), '[^[:alnum:]]', '', 'g')) = v_item;
        if v_used > v_allowed and not exists (
          select 1 from jsonb_array_elements(coalesce(v_result->'findings','[]'::jsonb)) as existing(value)
            where existing.value->>'code' = v_quantity_code
              and existing.value->>'stableKey' = v_quantity_stable_key
        ) then
          v_finding := jsonb_build_object(
            'code',v_quantity_code,'severity','error','status','needs_review',
            'stableKey',v_quantity_stable_key,
            'message',format('%s linked to PO %s consume %s units of an item ordered at %s. The combined quantity exceeds the PO.', case when v_document->>'type' = 'delivery_order' then 'Delivery orders' else 'Invoices' end, coalesce(v_po.analysis->'document'->>'poNumber', v_po.analysis->'document'->>'documentNumber',''), v_used, v_allowed),
            'sourceRefs',v_issue_refs,'expectedQuantity',v_allowed,'observedQuantity',v_used,'poNumber',coalesce(v_po.analysis->'document'->>'poNumber',v_po.analysis->'document'->>'documentNumber')
          );
          v_result := jsonb_set(v_result, '{findings}', coalesce(v_result->'findings','[]'::jsonb) || jsonb_build_array(v_finding), true);
          v_result := jsonb_set(v_result, '{status}', to_jsonb('needs_review'::text), true);
          v_status := 'needs_review';
        end if;
      end if;
    end loop;

    if v_document->>'type' = 'invoice' then
    v_po_total := public.numeric_or_null(v_po.analysis->'document'->>'totalAmountSen');
    if v_po_total is null then
      select sum(public.numeric_or_null(po_line.value->>'totalSen')) into v_po_total
        from jsonb_array_elements(case when jsonb_typeof(v_po.analysis->'document'->'lines') = 'array' then v_po.analysis->'document'->'lines' else '[]'::jsonb end) as po_line(value);
    end if;
    select coalesce(sum(coalesce(
      public.numeric_or_null(d.analysis->'document'->>'totalAmountSen'),
      (select sum(public.numeric_or_null(prior_line.value->>'totalSen')) from jsonb_array_elements(case when jsonb_typeof(d.analysis->'document'->'lines') = 'array' then d.analysis->'document'->'lines' else '[]'::jsonb end) as prior_line(value)),
      0
    )),0) into v_existing_total
      from public.documents d
      where d.business_id = p_business_id and d.linked_po_document_id = v_po_document_id and d.id <> p_document_id
        and coalesce(d.analysis->'document'->>'type','') = 'invoice'
        and d.status not in ('failed','needs_configuration');
    v_current_total := public.numeric_or_null(v_document->>'totalAmountSen');
    if v_current_total is null then
      select sum(public.numeric_or_null(current_line.value->>'totalSen')) into v_current_line_total
        from jsonb_array_elements(case when jsonb_typeof(v_document->'lines') = 'array' then v_document->'lines' else '[]'::jsonb end) as current_line(value);
      v_current_total := v_current_line_total;
    end if;
    if v_po_total > 0 and v_current_total is not null and v_existing_total + v_current_total > v_po_total
      and not exists (
        select 1 from jsonb_array_elements(coalesce(v_result->'findings','[]'::jsonb)) as existing(value)
          where existing.value->>'code' = 'PURCHASE_PO_BALANCE_EXCEEDED'
            and existing.value->>'stableKey' = 'purchase-po-balance:' || v_po_document_id::text || ':' || p_document_id::text
      ) then
      v_finding := jsonb_build_object(
        'code','PURCHASE_PO_BALANCE_EXCEEDED','severity','error','status','needs_review',
        'stableKey','purchase-po-balance:' || v_po_document_id::text || ':' || p_document_id::text,
        'message',format('Invoices linked to PO %s total RM%s, above its RM%s value.', coalesce(v_po.analysis->'document'->>'poNumber', v_po.analysis->'document'->>'documentNumber',''), to_char((v_existing_total + v_current_total)/100, 'FM999999999999990.00'), to_char(v_po_total/100, 'FM999999999999990.00')),
        'sourceRefs',v_issue_refs,'expectedAmountSen',v_po_total,'observedAmountSen',v_existing_total+v_current_total,
        'poNumber',coalesce(v_po.analysis->'document'->>'poNumber',v_po.analysis->'document'->>'documentNumber')
      );
      v_result := jsonb_set(v_result, '{findings}', coalesce(v_result->'findings','[]'::jsonb) || jsonb_build_array(v_finding), true);
      v_result := jsonb_set(v_result, '{status}', to_jsonb('needs_review'::text), true);
      v_status := 'needs_review';
    end if;
    end if;
  elsif v_po_document_id is not null and not exists (
    select 1 from public.documents po where po.id = v_po_document_id and po.business_id = p_business_id
      and coalesce(po.analysis->'document'->>'type', '') = 'purchase_order'
  ) then raise exception 'PO link must reference an existing purchase order in the same business' using errcode='42501'; end if;

  v_status := coalesce(v_result->>'status', v_status);
  update public.documents set status = v_status, workflow = v_workflow, analysis = coalesce(v_result->'analysis', jsonb_build_object('document', v_result->'document', 'agentResults', v_result->'agentResults')),
    findings = coalesce(v_result->'findings', '[]'::jsonb), linked_po_document_id = v_po_document_id, updated_at = now()
    where id = p_document_id and business_id = p_business_id;
  update public.jobs set status = v_status, completed_at = now(), lease_owner = null, lease_expires_at = null, updated_at = now()
    where id = p_job_id and business_id = p_business_id;
  for v_finding in select value from jsonb_array_elements(coalesce(v_result->'findings','[]'::jsonb)) loop
    v_key := coalesce(v_finding->>'stableKey', coalesce(v_finding->>'code','REVIEW_REQUIRED') || ':' || md5(coalesce(v_finding->'sourceRefs','[]'::jsonb)::text));
    insert into public.issues as current_issue(business_id, job_id, document_id, stable_key, code, severity, status, message, source_refs, expected, observed)
      values (p_business_id, p_job_id, p_document_id, v_key, coalesce(v_finding->>'code','REVIEW_REQUIRED'),
        case when v_finding->>'severity' in ('info','warning','error') then v_finding->>'severity' else 'warning' end,
        case when v_finding->>'status' in ('open','needs_review') then v_finding->>'status' else 'open' end,
        coalesce(v_finding->>'message','Review required.'), coalesce(v_finding->'sourceRefs','[]'::jsonb), v_finding->'expected', v_finding->'observed')
      on conflict (business_id, stable_key) do update set
        message = excluded.message, source_refs = excluded.source_refs,
        status = excluded.status, resolved_by = null, resolution_reason = null, resolved_at = null;
  end loop;
  insert into public.job_events(business_id, job_id, type, agent, state, summary, payload)
    values (p_business_id, p_job_id, 'proposal_persisted', 'documentation-db-agent', 'completed', 'Validated proposal and findings were stored.', jsonb_build_object('status', v_status));
  return jsonb_build_object('ok', true, 'status', v_status);
end;
$$;
revoke all on function public.persist_document_proposal(uuid,uuid,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.persist_document_proposal(uuid,uuid,uuid,jsonb) to service_role;

create or replace function public.record_document_correction(p_business_id uuid, p_document_id uuid, p_actor_id uuid, p_field text, p_value jsonb, p_reason text)
returns setof public.documents language plpgsql security definer set search_path = public
as $$
declare v_doc public.documents;
begin
  if length(trim(coalesce(p_reason,''))) < 3 then raise exception 'correction reason required'; end if;
  if p_field not in ('type','supplierName','buyerName','merchantName','documentNumber','invoiceNumber','poNumber','documentDate','totalAmountSen','paymentTerm','purpose','description','lines','categoryHints','accountCode') then
    raise exception 'unsupported correction field';
    end if;
  end if;
  update public.documents set manual_overrides = manual_overrides || jsonb_build_object(p_field,p_value), input_version = input_version + 1, updated_at = now()
    , manual_override_metadata = manual_override_metadata || jsonb_build_object(p_field,jsonb_build_object('actorId',p_actor_id,'reason',p_reason,'inputVersion',input_version+1,'createdAt',now()))
    where id = p_document_id and business_id = p_business_id returning * into v_doc;
  if not found then return; end if;
  insert into public.corrections(business_id,document_id,actor_id,field,value,reason,input_version)
    values (p_business_id,p_document_id,p_actor_id,p_field,p_value,p_reason,v_doc.input_version);
  insert into public.job_events(business_id,job_id,type,agent,state,summary,payload)
    select p_business_id,j.id,'field_corrected','human-review','completed',p_field || ' was corrected by a reviewer.',jsonb_build_object('actorId',p_actor_id,'inputVersion',v_doc.input_version)
    from public.jobs j where j.document_id = p_document_id and j.business_id = p_business_id;
  return next v_doc;
end;
$$;
revoke all on function public.record_document_correction(uuid,uuid,uuid,text,jsonb,text) from public, anon, authenticated;
grant execute on function public.record_document_correction(uuid,uuid,uuid,text,jsonb,text) to service_role;

create or replace function public.resolve_review_issue(p_business_id uuid, p_issue_id uuid, p_actor_id uuid, p_reason text)
returns setof public.issues language plpgsql security definer set search_path = public
as $$
declare v_issue public.issues;
begin
  if length(trim(coalesce(p_reason,''))) < 3 then raise exception 'resolution reason required'; end if;
  update public.issues set status='resolved', resolved_by=p_actor_id, resolution_reason=p_reason, resolved_at=now()
    where id=p_issue_id and business_id=p_business_id returning * into v_issue;
  if not found then return; end if;
  insert into public.job_events(business_id,job_id,type,agent,state,summary,payload)
    values (p_business_id,v_issue.job_id,'issue_resolved','human-review','completed','Issue ' || v_issue.code || ' was resolved by a reviewer.',jsonb_build_object('actorId',p_actor_id,'issueId',p_issue_id));
  return next v_issue;
end;
$$;
revoke all on function public.resolve_review_issue(uuid,uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.resolve_review_issue(uuid,uuid,uuid,text) to service_role;

create or replace function public.approve_intake_document(p_business_id uuid, p_document_id uuid, p_actor_id uuid)
returns setof public.documents language plpgsql security definer set search_path = public
as $$
declare v_doc public.documents;
begin
  select * into v_doc from public.documents where id=p_document_id and business_id=p_business_id for update;
  if not found then return; end if;
  if v_doc.analysis is null or v_doc.status not in ('completed','needs_review') then
    raise exception 'completed analysis is required before approval' using errcode='23514';
  end if;
  if exists (select 1 from public.issues where business_id=p_business_id and document_id=p_document_id and status <> 'resolved') then
    raise exception 'Resolve all open issues before approval.' using errcode='23514';
  end if;
  update public.documents set status='approved', approved_by=p_actor_id, approved_at=now(), updated_at=now()
    where id=p_document_id and business_id=p_business_id returning * into v_doc;
  if not found then return; end if;
  insert into public.job_events(business_id,job_id,type,agent,state,summary,payload)
    select p_business_id,j.id,'document_approved','human-review','completed','Document was approved by a reviewer.',jsonb_build_object('actorId',p_actor_id)
    from public.jobs j where j.business_id=p_business_id and j.document_id=p_document_id;
  return next v_doc;
end;
$$;
revoke all on function public.approve_intake_document(uuid,uuid,uuid) from public, anon, authenticated;
grant execute on function public.approve_intake_document(uuid,uuid,uuid) to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('documents', 'documents', false, 15728640, array['text/csv','text/tab-separated-values','text/plain','application/pdf','image/png','image/jpeg','image/webp','application/octet-stream'])
on conflict (id) do update set public=false, file_size_limit=15728640;

create policy "business members can read private documents" on storage.objects for select to authenticated
  using (bucket_id='documents' and exists (
    select 1 from public.business_memberships m join public.documents d on d.business_id=m.business_id
      and d.id::text=(storage.foldername(name))[2]
    where m.business_id::text = (storage.foldername(name))[1] and m.user_id = auth.uid()
      and (m.role in ('owner','reviewer') or (d.workflow='claim' and d.uploaded_by=auth.uid()))));
