alter table public.documents add column if not exists analysis_version integer;
alter table public.documents add column if not exists rejection_reason text;
alter table public.documents add column if not exists rejected_by uuid;
alter table public.documents add column if not exists rejected_at timestamptz;
alter table public.documents add column if not exists input_version integer not null default 1;
update public.documents set analysis_version = input_version where analysis is not null and analysis_version is null;

alter table public.jobs add column if not exists run_id uuid;
alter table public.jobs add column if not exists input_version integer not null default 1;
update public.jobs j set run_id = gen_random_uuid(), input_version = d.input_version
  from public.documents d where d.id = j.document_id and (j.run_id is null or j.input_version is null);
alter table public.jobs alter column run_id set default gen_random_uuid();
alter table public.jobs alter column run_id set not null;

alter table public.corrections add column if not exists previous_value jsonb;

do $$
declare v_constraint record;
begin
  for v_constraint in
    select conname from pg_constraint
    where conrelid = 'public.issues'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%status%'
  loop
    execute format('alter table public.issues drop constraint %I', v_constraint.conname);
  end loop;
end;
$$;
alter table public.issues add constraint issues_status_check check (status in ('open','needs_review','resolved','dismissed'));

create or replace function public.record_document_correction(p_business_id uuid, p_document_id uuid, p_actor_id uuid, p_field text, p_value jsonb, p_reason text)
returns setof public.documents language plpgsql security definer set search_path = public
as $$
declare v_doc public.documents; v_previous jsonb; v_job_status text;
begin
  if length(trim(coalesce(p_reason,''))) < 3 then raise exception 'correction reason required' using errcode='23514'; end if;
  if p_field not in ('type','supplierName','buyerName','merchantName','documentNumber','invoiceNumber','poNumber','documentDate','dueDate','totalAmountSen','paymentTerm','purpose','description','standardizedDescription','lines','categoryHints','accountCode','linkedPoDocumentId') then
    raise exception 'unsupported correction field' using errcode='23514';
  end if;
  select * into v_doc from public.documents where id=p_document_id and business_id=p_business_id for update;
  if not found then return; end if;
  if v_doc.status = 'approved' then raise exception 'approved documents cannot be edited' using errcode='23514'; end if;
  select status into v_job_status from public.jobs where document_id=p_document_id and business_id=p_business_id for update;
  if v_job_status in ('queued','processing') then raise exception 'wait for the current document check to finish before editing it' using errcode='23514'; end if;
  v_previous := coalesce(v_doc.manual_overrides->p_field, v_doc.analysis->'document'->p_field);
  update public.documents set manual_overrides = manual_overrides || jsonb_build_object(p_field,p_value),
      input_version = input_version + 1, status = 'needs_review', updated_at = now(),
      manual_override_metadata = manual_override_metadata || jsonb_build_object(p_field,jsonb_build_object('actorId',p_actor_id,'reason',p_reason,'inputVersion',input_version+1,'createdAt',now()))
    where id = p_document_id and business_id = p_business_id returning * into v_doc;
  insert into public.corrections(business_id,document_id,actor_id,field,value,previous_value,reason,input_version)
    values (p_business_id,p_document_id,p_actor_id,p_field,p_value,v_previous,p_reason,v_doc.input_version);
  insert into public.job_events(business_id,job_id,type,agent,state,summary,payload)
    select p_business_id,j.id,'field_corrected','human-review','completed',p_field || ' was corrected by a reviewer.',jsonb_build_object('actorId',p_actor_id,'inputVersion',v_doc.input_version)
    from public.jobs j where j.document_id = p_document_id and j.business_id = p_business_id;
  return next v_doc;
end;
$$;
revoke all on function public.record_document_correction(uuid,uuid,uuid,text,jsonb,text) from public, anon, authenticated;
grant execute on function public.record_document_correction(uuid,uuid,uuid,text,jsonb,text) to service_role;

create or replace function public.queue_intake_job_reprocess(p_business_id uuid, p_document_id uuid, p_job_id uuid)
returns boolean language plpgsql security definer set search_path = public
as $$
declare v_doc public.documents; v_job public.jobs; v_run uuid := gen_random_uuid();
begin
  select * into v_doc from public.documents where id=p_document_id and business_id=p_business_id for update;
  if not found then return false; end if;
  select * into v_job from public.jobs where id=p_job_id and document_id=p_document_id and business_id=p_business_id for update;
  if not found then return false; end if;
  if v_doc.status = 'approved' then raise exception 'approved documents cannot be reprocessed' using errcode='23514'; end if;
  if v_job.status in ('queued','processing') then raise exception 'this document is already being processed' using errcode='23514'; end if;
  update public.documents set status='queued', updated_at=now() where id=p_document_id and business_id=p_business_id;
  update public.jobs set status='queued', run_id=v_run, input_version=v_doc.input_version, error=null,
      lease_owner=null, lease_expires_at=null, completed_at=null, updated_at=now()
    where id=p_job_id and business_id=p_business_id;
  insert into public.job_events(business_id,job_id,type,agent,state,summary,payload)
    values (p_business_id,p_job_id,'job','workflow','queued','Checks queued after a reviewer correction.',jsonb_build_object('runId',v_run,'inputVersion',v_doc.input_version));
  return true;
end;
$$;
revoke all on function public.queue_intake_job_reprocess(uuid,uuid,uuid) from public, anon, authenticated;
grant execute on function public.queue_intake_job_reprocess(uuid,uuid,uuid) to service_role;

create or replace function public.persist_versioned_document_proposal(p_business_id uuid, p_job_id uuid, p_document_id uuid, p_run_id uuid, p_input_version integer, p_worker_id uuid, p_result jsonb)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare v_doc public.documents; v_job public.jobs; v_result jsonb;
begin
  select * into v_doc from public.documents where id=p_document_id and business_id=p_business_id for update;
  if not found then raise exception 'proposal scope mismatch' using errcode='42501'; end if;
  select * into v_job from public.jobs where id=p_job_id and document_id=p_document_id and business_id=p_business_id for update;
  if not found then raise exception 'proposal scope mismatch' using errcode='42501'; end if;
  if v_job.run_id is distinct from p_run_id or v_job.input_version <> p_input_version
      or v_doc.input_version <> p_input_version or v_job.lease_owner is distinct from p_worker_id
      or v_job.status <> 'processing' then
    raise exception 'stale processing result' using errcode='40001';
  end if;
  v_result := public.persist_document_proposal(p_business_id,p_job_id,p_document_id,p_result);
  update public.documents set analysis_version=p_input_version where id=p_document_id and business_id=p_business_id;
  return v_result;
end;
$$;
revoke all on function public.persist_versioned_document_proposal(uuid,uuid,uuid,uuid,integer,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.persist_versioned_document_proposal(uuid,uuid,uuid,uuid,integer,uuid,jsonb) to service_role;

create or replace function public.set_review_issue_status(p_business_id uuid, p_issue_id uuid, p_actor_id uuid, p_status text, p_reason text)
returns setof public.issues language plpgsql security definer set search_path = public
as $$
declare v_issue public.issues; v_old text;
begin
  if p_status not in ('open','needs_review','resolved','dismissed') then raise exception 'invalid issue status' using errcode='23514'; end if;
  if length(trim(coalesce(p_reason,''))) < 3 then raise exception 'a review reason is required' using errcode='23514'; end if;
  select * into v_issue from public.issues where id=p_issue_id and business_id=p_business_id for update;
  if not found then return; end if;
  v_old := v_issue.status;
  update public.issues set status=p_status, resolved_by=p_actor_id, resolution_reason=trim(p_reason),
      resolved_at=case when p_status in ('resolved','dismissed') then now() else null end
    where id=p_issue_id and business_id=p_business_id returning * into v_issue;
  insert into public.job_events(business_id,job_id,type,agent,state,summary,payload)
    values (p_business_id,v_issue.job_id,case when p_status='resolved' then 'issue_resolved' else 'issue_status_changed' end,'human-review','completed',
      'Issue ' || v_issue.code || ' changed from ' || v_old || ' to ' || p_status || '.',
      jsonb_build_object('actorId',p_actor_id,'issueId',p_issue_id,'reason',trim(p_reason)));
  return next v_issue;
end;
$$;
revoke all on function public.set_review_issue_status(uuid,uuid,uuid,text,text) from public, anon, authenticated;
grant execute on function public.set_review_issue_status(uuid,uuid,uuid,text,text) to service_role;

create or replace function public.reject_intake_document(p_business_id uuid, p_document_id uuid, p_actor_id uuid, p_reason text)
returns setof public.documents language plpgsql security definer set search_path = public
as $$
declare v_doc public.documents; v_job public.jobs;
begin
  if length(trim(coalesce(p_reason,''))) < 3 then raise exception 'a rejection reason is required' using errcode='23514'; end if;
  select * into v_doc from public.documents where id=p_document_id and business_id=p_business_id for update;
  if not found then return; end if;
  if v_doc.status = 'approved' then raise exception 'approved documents cannot be rejected' using errcode='23514'; end if;
  select * into v_job from public.jobs where document_id=p_document_id and business_id=p_business_id for update;
  if found and v_job.status in ('queued','processing') then raise exception 'wait for processing to finish before rejecting this document' using errcode='23514'; end if;
  update public.documents set status='rejected', rejection_reason=trim(p_reason), rejected_by=p_actor_id, rejected_at=now(), updated_at=now()
    where id=p_document_id and business_id=p_business_id returning * into v_doc;
  insert into public.job_events(business_id,job_id,type,agent,state,summary,payload)
    select p_business_id,j.id,'document_rejected','human-review','completed','Document was rejected by a reviewer.',jsonb_build_object('actorId',p_actor_id,'reason',trim(p_reason))
    from public.jobs j where j.document_id=p_document_id and j.business_id=p_business_id;
  return next v_doc;
end;
$$;
revoke all on function public.reject_intake_document(uuid,uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.reject_intake_document(uuid,uuid,uuid,text) to service_role;

create or replace function public.approve_intake_document(p_business_id uuid, p_document_id uuid, p_actor_id uuid)
returns setof public.documents language plpgsql security definer set search_path = public
as $$
declare v_doc public.documents;
begin
  select * into v_doc from public.documents where id=p_document_id and business_id=p_business_id for update;
  if not found then return; end if;
  if v_doc.analysis is null or v_doc.status not in ('completed','needs_review') or v_doc.analysis_version is distinct from v_doc.input_version then
    raise exception 'completed current analysis is required before approval' using errcode='23514';
  end if;
  if exists (select 1 from public.issues where business_id=p_business_id and document_id=p_document_id and status not in ('resolved','dismissed')) then
    raise exception 'Resolve all open issues before approval.' using errcode='23514';
  end if;
  update public.documents set status='approved', approved_by=p_actor_id, approved_at=now(), updated_at=now()
    where id=p_document_id and business_id=p_business_id returning * into v_doc;
  insert into public.job_events(business_id,job_id,type,agent,state,summary,payload)
    select p_business_id,j.id,'document_approved','human-review','completed','Document was approved by a reviewer.',jsonb_build_object('actorId',p_actor_id)
    from public.jobs j where j.business_id=p_business_id and j.document_id=p_document_id;
  return next v_doc;
end;
$$;
revoke all on function public.approve_intake_document(uuid,uuid,uuid) from public, anon, authenticated;
grant execute on function public.approve_intake_document(uuid,uuid,uuid) to service_role;
