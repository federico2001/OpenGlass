import type { IndexDescription } from "mongodb";
import type { z } from "zod";

export interface CollectionDef<S extends z.ZodType = z.ZodType> {
  name: string;
  schema: S;
  /** Every index must have an explicit, stable name. */
  indexes: (IndexDescription & { name: string })[];
  /** Documents are never updated or deleted (SPEC §3, CLAUDE.md). */
  appendOnly?: boolean;
}

export const defineCollection = <S extends z.ZodType>(def: CollectionDef<S>) => def;
