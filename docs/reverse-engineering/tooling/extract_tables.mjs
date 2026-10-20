// Static (non-executing) extraction of ServiceNow SDK fluent table definitions.
// usage: node extract_tables.mjs <tables_dir> <out.json>
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const acorn = require(process.env.ACORN_PATH);

const [dir, out] = process.argv.slice(2);

function calleeName(node) {
  // (0, db_1.IntegerColumn)(...)  or db_1.Table(...)
  let c = node.callee;
  if (c.type === "SequenceExpression") c = c.expressions[c.expressions.length - 1];
  if (c.type === "MemberExpression") return c.property.name;
  if (c.type === "Identifier") return c.name;
  return null;
}

function lit(node) {
  switch (node.type) {
    case "Literal": return node.value;
    case "TemplateLiteral": return node.quasis.map((q) => q.value.cooked).join("${}");
    case "ArrayExpression": return node.elements.map((e) => (e ? lit(e) : null));
    case "ObjectExpression": {
      const o = {};
      for (const p of node.properties) {
        if (p.type !== "Property") continue;
        const k = p.key.type === "Identifier" ? p.key.name : p.key.value;
        o[k] = lit(p.value);
      }
      return o;
    }
    case "UnaryExpression": return node.operator === "-" ? -lit(node.argument) : `<${node.operator}>`;
    case "CallExpression": {
      const name = calleeName(node);
      const args = node.arguments.map(lit);
      return { $call: name, args };
    }
    case "Identifier": return { $ident: node.name };
    case "MemberExpression": return { $member: `${node.object.name ?? "?"}.${node.property.name ?? "?"}` };
    default: return { $unsupported: node.type };
  }
}

const result = {};
for (const f of readdirSync(dir).filter((x) => x.endsWith(".now.js")).sort()) {
  const src = readFileSync(join(dir, f), "utf8");
  const ast = acorn.parse(src, { ecmaVersion: "latest", sourceType: "script" });
  const walk = (n) => {
    if (!n || typeof n !== "object") return;
    if (n.type === "CallExpression" && calleeName(n) === "Table") {
      const def = lit(n.arguments[0]);
      const schema = {};
      for (const [col, v] of Object.entries(def.schema ?? {})) {
        schema[col] = v && v.$call ? { type: v.$call, ...(v.args[0] ?? {}) } : v;
      }
      def.schema = schema;
      result[def.name] = { file: f, ...def };
      return;
    }
    for (const k of Object.keys(n)) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v.type === "string") walk(v);
    }
  };
  walk(ast);
}
writeFileSync(out, JSON.stringify(result, null, 1));
console.log(`extracted ${Object.keys(result).length} tables`);
