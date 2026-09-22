import { z } from "zod";

/**
 * Converts the subset of Zod used by our models into a MongoDB `$jsonSchema`
 * (draft-4 + bsonType). The Zod model is the single source of truth; anything
 * outside the supported subset throws so a model can't silently lose rules.
 */

export type BsonSchema = Record<string, unknown>;

const overrides = new WeakMap<z.ZodType, BsonSchema>();

/** Attach a fixed BSON schema to a Zod schema the converter can't express (e.g. ObjectId). */
export function withBson<T extends z.ZodType>(schema: T, bson: BsonSchema): T {
  overrides.set(schema, bson);
  return schema;
}

type Def = { type: string; [k: string]: any };
const defOf = (s: z.ZodType): Def => (s as any)._zod.def;
const checksOf = (s: z.ZodType): Def[] => (defOf(s).checks ?? []).map((c: any) => c._zod.def);

function isOptional(s: z.ZodType): boolean {
  const t = defOf(s).type;
  return t === "optional" || t === "default";
}

export function toBsonSchema(schema: z.ZodType): BsonSchema {
  const override = overrides.get(schema);
  if (override) return override;

  const def = defOf(schema);
  switch (def.type) {
    case "string": {
      const out: BsonSchema = { bsonType: "string" };
      for (const c of checksOf(schema)) {
        if (c.check === "min_length") out.minLength = c.minimum;
        else if (c.check === "max_length") out.maxLength = c.maximum;
        else if (c.check === "length_equals") out.minLength = out.maxLength = c.length;
        else if (c.check === "string_format" && c.format === "regex") out.pattern = (c.pattern as RegExp).source;
        else if (c.check === "string_format") {
          /* named formats (email, url…) are validated by Zod only */
        } else throw new Error(`Unsupported string check: ${c.check}`);
      }
      return out;
    }
    case "number": {
      const checks = checksOf(schema);
      const isInt = def.format === "safeint" || checks.some((c) => c.check === "number_format" && c.format === "safeint");
      const out: BsonSchema = { bsonType: isInt ? ["int", "long"] : ["double", "int", "long"] };
      for (const c of checks) {
        if (c.check === "number_format") continue;
        if (c.check === "greater_than") {
          out.minimum = c.value;
          if (!c.inclusive) out.exclusiveMinimum = true;
        } else if (c.check === "less_than") {
          out.maximum = c.value;
          if (!c.inclusive) out.exclusiveMaximum = true;
        } else throw new Error(`Unsupported number check: ${c.check}`);
      }
      return out;
    }
    case "boolean":
      return { bsonType: "bool" };
    case "date":
      return { bsonType: "date" };
    case "enum":
      return { enum: Object.values(def.entries) };
    case "literal":
      return { enum: def.values };
    case "unknown":
    case "any":
      return {};
    case "optional":
    case "default":
      return toBsonSchema(def.innerType);
    case "nullable": {
      const inner = toBsonSchema(def.innerType);
      if (Array.isArray(inner.enum)) return { ...inner, enum: [...inner.enum, null] };
      if (inner.bsonType && !inner.anyOf) {
        const types = Array.isArray(inner.bsonType) ? inner.bsonType : [inner.bsonType];
        return { ...inner, bsonType: [...types, "null"] };
      }
      return { anyOf: [inner, { bsonType: "null" }] };
    }
    case "union":
      return { anyOf: (def.options as z.ZodType[]).map(toBsonSchema) };
    case "array": {
      const out: BsonSchema = { bsonType: "array", items: toBsonSchema(def.element) };
      for (const c of checksOf(schema)) {
        if (c.check === "min_length") out.minItems = c.minimum;
        else if (c.check === "max_length") out.maxItems = c.maximum;
        else throw new Error(`Unsupported array check: ${c.check}`);
      }
      return out;
    }
    case "object": {
      const shape = def.shape as Record<string, z.ZodType>;
      const properties: Record<string, BsonSchema> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = toBsonSchema(value);
        if (!isOptional(value)) required.push(key);
      }
      const out: BsonSchema = { bsonType: "object", properties };
      if (required.length) out.required = required;
      const catchall = def.catchall ? defOf(def.catchall).type : undefined;
      if (catchall === "never") out.additionalProperties = false;
      else if (catchall && catchall !== "unknown") throw new Error(`Unsupported object catchall: ${catchall}`);
      return out;
    }
    case "record": {
      const value = toBsonSchema(def.valueType);
      return Object.keys(value).length ? { bsonType: "object", additionalProperties: value } : { bsonType: "object" };
    }
    default:
      throw new Error(`Unsupported Zod type for $jsonSchema: ${def.type}`);
  }
}
