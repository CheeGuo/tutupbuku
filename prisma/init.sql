-- Generated from prisma/schema.prisma by: npm run db:sql
-- Alternative to `npm run db:push`: paste into the Supabase SQL editor (works over HTTPS).
-- Everything is created in the tutupbuku schema, separate from public.

CREATE SCHEMA IF NOT EXISTS "tutupbuku";
SET search_path TO "tutupbuku";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "tutupbuku";

-- CreateEnum
CREATE TYPE "DocType" AS ENUM ('quotation', 'purchase_order', 'delivery_order', 'invoice', 'payment_advice', 'payment_receipt', 'claim_receipt', 'unclassified');

-- CreateEnum
CREATE TYPE "DocStatus" AS ENUM ('UPLOADED', 'EXTRACTED', 'MATCHED', 'NEEDS_REVIEW', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "Flow" AS ENUM ('purchasing', 'claims');

-- CreateEnum
CREATE TYPE "LinkRelationship" AS ENUM ('for_po', 'settles_invoice');

-- CreateEnum
CREATE TYPE "ClaimStatus" AS ENUM ('PLAUSIBLE', 'NEEDS_REVIEW', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "Severity" AS ENUM ('INFO', 'WARNING', 'HIGH');

-- CreateEnum
CREATE TYPE "IssueStatus" AS ENUM ('OPEN', 'UNDER_REVIEW', 'RESOLVED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "ActorKind" AS ENUM ('human', 'agent');

-- CreateTable
CREATE TABLE "documents" (
    "id" TEXT NOT NULL,
    "doc_type" "DocType" NOT NULL,
    "flow" "Flow" NOT NULL,
    "filename" TEXT NOT NULL,
    "fields" JSONB NOT NULL DEFAULT '[]',
    "lines" JSONB NOT NULL DEFAULT '[]',
    "status" "DocStatus" NOT NULL,
    "hash" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "uploaded_at" TEXT NOT NULL,
    "uploaded_by" TEXT NOT NULL,
    "note" TEXT,
    "source_url" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_links" (
    "id" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "relationship" "LinkRelationship" NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "confirmed_by" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "claims" (
    "id" TEXT NOT NULL,
    "employee" TEXT NOT NULL,
    "receipt_doc_id" TEXT NOT NULL,
    "employee_purpose" TEXT NOT NULL,
    "category_code" TEXT,
    "category_confidence" DOUBLE PRECISION NOT NULL,
    "category_reasoning" TEXT NOT NULL,
    "alternative_codes" TEXT[],
    "standardized_description" TEXT NOT NULL,
    "findings" TEXT[],
    "status" "ClaimStatus" NOT NULL,
    "decision" JSONB,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "issues" (
    "id" TEXT NOT NULL,
    "rule_code" TEXT NOT NULL,
    "type_label" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "severity" "Severity" NOT NULL,
    "status" "IssueStatus" NOT NULL,
    "doc_ids" TEXT[],
    "claim_id" TEXT,
    "field_key" TEXT,
    "candidate_ids" TEXT[],
    "detected" TEXT NOT NULL,
    "why" TEXT NOT NULL,
    "suggested" TEXT[],
    "evidence" JSONB NOT NULL DEFAULT '[]',
    "created_at" TEXT NOT NULL,
    "resolution" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "issues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_entries" (
    "id" TEXT NOT NULL,
    "timestamp" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "actor_kind" "ActorKind" NOT NULL,
    "action" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "previous" TEXT,
    "next" TEXT,

    CONSTRAINT "audit_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_meta" (
    "key" TEXT NOT NULL,
    "value" INTEGER NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_meta_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "documents_flow_status_idx" ON "documents"("flow", "status");

-- CreateIndex
CREATE INDEX "documents_doc_type_idx" ON "documents"("doc_type");

-- CreateIndex
CREATE INDEX "document_links_source_id_idx" ON "document_links"("source_id");

-- CreateIndex
CREATE INDEX "document_links_target_id_idx" ON "document_links"("target_id");

-- CreateIndex
CREATE INDEX "claims_status_idx" ON "claims"("status");

-- CreateIndex
CREATE INDEX "issues_status_severity_idx" ON "issues"("status", "severity");

-- CreateIndex
CREATE INDEX "audit_entries_entity_id_idx" ON "audit_entries"("entity_id");

-- AddForeignKey
ALTER TABLE "document_links" ADD CONSTRAINT "document_links_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_links" ADD CONSTRAINT "document_links_target_id_fkey" FOREIGN KEY ("target_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claims" ADD CONSTRAINT "claims_receipt_doc_id_fkey" FOREIGN KEY ("receipt_doc_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


INSERT INTO "workspace_meta" ("key", "value") VALUES ('version', 0) ON CONFLICT ("key") DO NOTHING;
