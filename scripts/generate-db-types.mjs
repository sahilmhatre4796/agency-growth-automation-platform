import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
const db = new PGlite();
try {
  await db.exec(
    "create role service_role bypassrls; create role anon; create role authenticated; create schema auth; create table auth.users(id uuid primary key); create function auth.uid() returns uuid language sql stable as $$select null::uuid$$;",
  );
  for (const file of readdirSync("supabase/migrations")
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    await db.exec(
      readFileSync(`supabase/migrations/${file}`, "utf8").replace(
        "create extension if not exists pgcrypto;",
        "",
      ),
    );
  }
  const { rows } = await db.query(
    "select table_name,column_name,data_type,is_nullable,column_default from information_schema.columns where table_schema='public' order by table_name,ordinal_position",
  );
  const tables = Object.groupBy(rows, (r) => r.table_name);
  const type = (row) => {
    const mapped =
      row.data_type === "boolean"
        ? "boolean"
        : ["integer", "bigint", "smallint", "numeric"].includes(row.data_type)
          ? "number"
          : row.data_type === "jsonb"
            ? "Json"
            : row.data_type === "ARRAY"
              ? "string[]"
              : "string";
    return mapped + (row.is_nullable === "YES" ? " | null" : "");
  };
  let output =
    "// Generated from core migrations by npm run db:types. Never hand edit.\nexport type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];\nexport type Database = { public: { Tables: {\n";
  for (const [table, columns] of Object.entries(tables)) {
    output += `${table}: { Row: {\n${columns.map((c) => `${c.column_name}: ${type(c)};`).join("\n")}\n}; Insert: {\n${columns.map((c) => `${c.column_name}${c.is_nullable === "YES" || c.column_default !== null ? "?" : ""}: ${type(c)};`).join("\n")}\n}; Update: {\n${columns.map((c) => `${c.column_name}?: ${type(c)};`).join("\n")}\n}; Relationships: [] };\n`;
  }
  output +=
    "}; Views: Record<string, never>; Functions: Record<string, never>; Enums: Record<string, never>; CompositeTypes: Record<string, never> } };\n";
  writeFileSync("packages/shared/database.types.ts", output);
  console.log(`Generated types for ${Object.keys(tables).length} core tables.`);
} finally {
  await db.close();
}

