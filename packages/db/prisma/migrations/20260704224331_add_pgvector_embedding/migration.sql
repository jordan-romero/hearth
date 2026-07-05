-- Enable pgvector for semantic retrieval.
CREATE EXTENSION IF NOT EXISTS vector;

-- Add the embedding column to the memory's atoms (Voyage embeddings, 1024-dim).
ALTER TABLE "KnowledgeUnit" ADD COLUMN "embedding" vector(1024);
