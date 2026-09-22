import { describe, expect, it } from "vitest";
import { z } from "zod";
import { toBsonSchema } from "../src/jsonSchema.js";
import { databaseNameFromUri } from "../src/client.js";

describe("toBsonSchema", () => {
  it("maps strict objects, optionals and nullables", () => {
    const s = z.strictObject({ a: z.string().min(1).max(3), b: z.int().min(0).optional(), c: z.date().nullable() });
    expect(toBsonSchema(s)).toEqual({
      bsonType: "object",
      additionalProperties: false,
      required: ["a", "c"],
      properties: {
        a: { bsonType: "string", minLength: 1, maxLength: 3 },
        b: { bsonType: ["int", "long"], minimum: 0 },
        c: { bsonType: ["date", "null"] },
      },
    });
  });

  it("maps enums, literals, arrays, unions and regexes", () => {
    expect(toBsonSchema(z.enum(["x", "y"]).nullable())).toEqual({ enum: ["x", "y", null] });
    expect(toBsonSchema(z.literal(1))).toEqual({ enum: [1] });
    expect(toBsonSchema(z.array(z.boolean()).min(2).max(2))).toEqual({
      bsonType: "array", items: { bsonType: "bool" }, minItems: 2, maxItems: 2,
    });
    expect(toBsonSchema(z.union([z.string(), z.number()]))).toEqual({
      anyOf: [{ bsonType: "string" }, { bsonType: ["double", "int", "long"] }],
    });
    expect(toBsonSchema(z.string().regex(/^[a-f]+$/))).toEqual({ bsonType: "string", pattern: "^[a-f]+$" });
  });

  it("rejects unsupported types instead of silently dropping rules", () => {
    expect(() => toBsonSchema(z.bigint())).toThrow(/Unsupported/);
    expect(() => toBsonSchema(z.string().transform((s) => s.length))).toThrow(/Unsupported/);
  });
});

describe("databaseNameFromUri", () => {
  it("reads the database from the URI path", () => {
    expect(databaseNameFromUri("mongodb://mongo:27017/openglass?replicaSet=rs0")).toBe("openglass");
    expect(databaseNameFromUri("mongodb+srv://u:p@c0.abcd.mongodb.net/openglass?retryWrites=true")).toBe("openglass");
    expect(databaseNameFromUri("mongodb://a:1,b:2/og")).toBe("og");
  });

  it("refuses a URI without a database", () => {
    expect(() => databaseNameFromUri("mongodb://mongo:27017/?replicaSet=rs0")).toThrow(/database name/);
    expect(() => databaseNameFromUri("mongodb://mongo:27017")).toThrow(/database name/);
  });
});
