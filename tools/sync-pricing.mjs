#!/usr/bin/env node
/**
 * Rewrites the pricing page (and every UTM Fox price / plan-name mention across the site)
 * from the live plan data in the app's database.
 *
 * Run:  node tools/sync-pricing.mjs [--check]
 *       --check exits 1 if anything would change, without writing. Used to fail loudly
 *       in CI if someone hand-edits a generated region.
 *
 * Design notes:
 * - Only the regions between <!-- uf:*:start --> and <!-- uf:*:end --> are replaced, plus
 *   elements carrying data-uf-* attributes. Everything else on these pages is hand-written
 *   marketing copy and must survive untouched.
 * - Everything is keyed off the plan's stable `key`, never its display name, so renaming
 *   "Free" to "Basic" in the staff dashboard is a pure copy change.
 * - Output is deterministic: identical input produces byte-identical output, so the
 *   scheduled workflow only commits when the pricing actually moved.
 */
import fs from "node:fs";
import path from "node:path";

const API = process.env.PLANS_API ?? "https://app.utmfox.com/api/v1/public/plans";
const ROOT = path.resolve(import.meta.dirname, "..");
const CHECK = process.argv.includes("--check");

/* ---------------------------------------------------------------------------
 * Copy that is NOT in the database, keyed by the stable plan/feature key.
 * Ryan scoped the dashboard to numbers, feature rows and plan names; taglines and
 * section headings stay here. A key missing from these maps degrades gracefully
 * rather than throwing, so adding a plan in the dashboard can never blank the page.
 * ------------------------------------------------------------------------- */
const PLAN_COPY = {
  free:     { tagline: "For one person testing whether governance is worth it.", cta: "Start free" },
  starter:  { tagline: "For a small team that finally wants one naming convention.", cta: "Start free trial" },
  growth:   { tagline: "For teams running paid media who need to prove it worked.", cta: "Start free trial", featured: "Most popular" },
  business: { tagline: "For orgs where marketing ops answers to compliance.", cta: "Start free trial" },
  agency:   { tagline: "For agencies governing campaigns across many client accounts.", cta: "Contact sales", contact: true },
};

const SECTIONS = [
  { title: "Price", rows: [{ kind: "price", label: "Monthly" }] },
  {
    title: "Limits",
    rows: [
      { key: "max_seats", label: "Seats" },
      { key: "max_campaigns", label: "Campaigns" },
      { key: "max_sessions_per_month", label: "Tracked sessions / month" },
      { key: "max_domains", label: "Connected domains" },
      { key: "max_redirects", label: "Vanity redirects" },
      { key: "utm_wiki_max_links", label: "utm.wiki short links" },
    ],
  },
  {
    title: "Govern &amp; validate",
    rows: [
      { key: "governance", label: "Governance rules engine", note: "Approved sources/mediums, required params, naming patterns" },
      { key: "health_monitoring", label: "Health monitoring", note: "Destination re-checked on every campaign edit and redirect change" },
    ],
  },
  {
    title: "Deploy",
    rows: [
      { key: "smart_redirects", label: "Smart redirects on your own domain", note: "Written into your Cloudflare account by OAuth" },
      { key: "utm_wiki_fallback", label: "Instant utm.wiki short links", note: "Works before any domain is connected" },
    ],
  },
  {
    title: "Measure",
    rows: [
      { key: "ga4_integration", label: "GA4 integration" },
      { key: "attribution_monitoring", label: "Attribution monitoring", note: "Campaigns with no traffic; traffic with no campaign" },
      { key: "conversion_ledger", label: "Conversion ledger", note: "Deduped conversion claims ranked by source authority" },
    ],
  },
  {
    title: "Administration",
    rows: [
      { key: "sso", label: "SSO / SCIM" },
      { key: "audit_log_export", label: "Audit log export" },
    ],
  },
];

// Bullets on each plan card, in order. Rendered only when the plan actually has the value.
const CARD_LIMITS = [
  { key: "max_seats", one: "seat", many: "seats" },
  { key: "max_campaigns", one: "campaign", many: "campaigns" },
  { key: "max_sessions_per_month", one: "session/mo", many: "sessions/mo" },
  { key: "max_domains", one: "domain", many: "domains" },
  { key: "max_redirects", one: "vanity redirect", many: "vanity redirects" },
  { key: "utm_wiki_max_links", one: "utm.wiki short link", many: "utm.wiki short links" },
];
// Booleans worth calling out on a card, but only on the first plan that introduces them.
const CARD_HIGHLIGHTS = [
  { key: "governance", label: "Governance rules" },
  { key: "health_monitoring", label: "Health monitoring" },
  { key: "smart_redirects", label: "Smart redirects" },
  { key: "ga4_integration", label: "GA4 integration" },
  { key: "attribution_monitoring", label: "Attribution monitoring" },
  { key: "conversion_ledger", label: "Conversion ledger" },
  { key: "sso", label: "SSO / SCIM" },
  { key: "audit_log_export", label: "Audit log export" },
];

/* --------------------------------- formatting ---------------------------- */
const esc = (v) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const num = (n) => n.toLocaleString("en-US");

function priceLabel(plan) {
  if (PLAN_COPY[plan.key]?.contact) return "Custom";
  if (plan.priceCents === 0) return "$0";
  return `$${Math.round(plan.priceCents / 100).toLocaleString("en-US")}`;
}
function periodLabel(plan) {
  if (PLAN_COPY[plan.key]?.contact) return "talk to us";
  if (plan.priceCents === 0) return "forever";
  return plan.billingInterval === "year" ? "per year" : "per month";
}
// null limit = unlimited, 0 = not included, absent = feature not on this plan at all.
function limitLabel(value) {
  if (value === undefined) return null;
  if (value === null) return "Unlimited";
  if (value === 0) return null;
  return num(value);
}

/* --------------------------------- rendering ----------------------------- */
function renderCards(plans) {
  return plans
    .map((plan, i) => {
      const copy = PLAN_COPY[plan.key] ?? {};
      const prev = plans[i - 1];
      const featured = copy.featured ? ' featured' : "";
      const btn = copy.featured ? "btn-primary" : "btn-secondary";
      const href = copy.contact ? "/#contact" : "https://app.utmfox.com/signup";

      const bullets = [];
      if (prev) bullets.push(`<li class="head">Everything in <span data-uf-plan="${prev.key}">${esc(prev.name)}</span>, plus</li>`);

      for (const l of CARD_LIMITS) {
        const raw = plan.values[l.key];
        const label = limitLabel(raw);
        if (label === null) continue;
        const unit = raw === 1 ? l.one : l.many;
        bullets.push(`<li><span class="tick">✓</span> ${label} ${unit}</li>`);
      }
      for (const h of CARD_HIGHLIGHTS) {
        if (plan.values[h.key] !== true) continue;
        if (prev && prev.values[h.key] === true) continue; // already implied by "everything in X"
        bullets.push(`<li><span class="tick">✓</span> <strong>${h.label}</strong></li>`);
      }
      if (plan.values.smart_redirects === false) {
        bullets.push(`<li class="off"><span class="tick off">–</span> No custom-domain redirects</li>`);
      }

      return `        <div class="plan${featured}">
${copy.featured ? `          <div class="plan-flag">${esc(copy.featured)}</div>\n` : ""}          <div class="plan-name" data-uf-plan="${plan.key}">${esc(plan.name)}</div>
          <div class="plan-price" data-uf-price="${plan.key}">${priceLabel(plan)}</div>
          <div class="plan-period">${periodLabel(plan)}</div>
          <p class="plan-for">${esc(copy.tagline ?? "")}</p>
          <a class="${btn} plan-cta" href="${href}">${esc(copy.cta ?? "Get started")}</a>
          <ul class="plan-feats">
${bullets.map((b) => "            " + b).join("\n")}
          </ul>
        </div>`;
    })
    .join("\n\n");
}

function renderMatrixHead(plans) {
  return plans
    .map((p) => {
      const cls = PLAN_COPY[p.key]?.featured ? ' class="us"' : "";
      return `<th${cls} data-uf-plan="${p.key}">${esc(p.name)}</th>`;
    })
    .join("");
}

function renderMatrix(plans, features) {
  const known = new Set(SECTIONS.flatMap((s) => s.rows.map((r) => r.key).filter(Boolean)));
  // Anything the dashboard grows later still shows up, using the feature's own name,
  // rather than silently vanishing from the public page.
  const extras = features.filter((f) => !known.has(f.key));
  const sections = extras.length
    ? [...SECTIONS, { title: "More", rows: extras.map((f) => ({ key: f.key, label: f.name })) }]
    : SECTIONS;

  const out = [];
  for (const section of sections) {
    out.push(`          <tr class="group"><td colspan="${plans.length + 1}">${section.title}</td></tr>`);
    for (const row of section.rows) {
      const cells = plans.map((p) => {
        const us = PLAN_COPY[p.key]?.featured ? "us " : "";
        if (row.kind === "price") {
          return `<td class="${us.trim()}" data-uf-price="${p.key}"><strong>${priceLabel(p)}</strong></td>`;
        }
        const feature = features.find((f) => f.key === row.key);
        const value = p.values[row.key];
        if (feature?.type === "boolean") {
          return value === true
            ? `<td class="${us}yes">✓</td>`
            : `<td class="${us}no">—</td>`;
        }
        if (value === undefined || value === 0) return `<td class="${us}no">—</td>`;
        if (value === null) return `<td class="${us}inf">Unlimited</td>`;
        return `<td class="${us.trim()}" data-uf-limit="${p.key}:${row.key}">${num(value)}</td>`;
      });
      const note = row.note ? `<span class="cell-note">${row.note}</span>` : "";
      out.push(`          <tr><td class="feat">${row.label}${note}</td>${cells.join("")}</tr>`);
    }
  }
  return out.join("\n");
}

/* --------------------------------- rewriting ----------------------------- */
function replaceRegion(html, name, body) {
  const re = new RegExp(`(<!-- uf:${name}:start -->)[\\s\\S]*?(<!-- uf:${name}:end -->)`);
  if (!re.test(html)) throw new Error(`marker uf:${name} not found`);
  // Replacer FUNCTION, not a replacement string: the body is full of prices like "$29",
  // and in a replacement string "$2" is a backreference. That silently rewrote every
  // price into a capture group the first time this ran.
  return html.replace(re, (_m, start, end) => `${start}\n${body}\n${end}`);
}

// Fills every data-uf-* element wherever it appears. Inner HTML is replaced only up to any
// nested <span> the template owns (e.g. the "/mo" suffix), which is why the price/limit
// patterns are anchored on the tag's own text run.
function fillTokens(html, { priceByKey, nameByKey, limitByKey }) {
  html = html.replace(
    /(<(\w+)([^>]*\bdata-uf-price="([^"]+)"[^>]*)>)([^<]*)/g,
    (m, open, _tag, _attrs, key, text) => (priceByKey[key] === undefined ? m : open + priceByKey[key])
  );
  html = html.replace(
    /(<(\w+)([^>]*\bdata-uf-plan="([^"]+)"[^>]*)>)([^<]*)/g,
    (m, open, _tag, _attrs, key, text) => (nameByKey[key] === undefined ? m : open + esc(nameByKey[key]))
  );
  html = html.replace(
    /(<(\w+)([^>]*\bdata-uf-limit="([^"]+)"[^>]*)>)([^<]*)/g,
    (m, open, _tag, _attrs, key, text) => (limitByKey[key] === undefined ? m : open + limitByKey[key])
  );
  return html;
}

/* ----------------------------------- main -------------------------------- */
const res = await fetch(API, { headers: { accept: "application/json" } });
if (!res.ok) throw new Error(`${API} responded ${res.status}`);
const data = await res.json();
if (data.schema !== 1) throw new Error(`unexpected payload schema ${data.schema}`);
if (!Array.isArray(data.plans) || data.plans.length === 0) throw new Error("no active plans returned");

const plans = [...data.plans].sort((a, b) => a.sortOrder - b.sortOrder);
const features = data.features ?? [];

const priceByKey = Object.fromEntries(plans.map((p) => [p.key, priceLabel(p)]));
const nameByKey = Object.fromEntries(plans.map((p) => [p.key, p.name]));
const limitByKey = {};
for (const p of plans) {
  for (const [fk, v] of Object.entries(p.values)) {
    if (typeof v === "number") limitByKey[`${p.key}:${fk}`] = num(v);
    else if (v === null) limitByKey[`${p.key}:${fk}`] = "Unlimited";
  }
}

const targets = ["pricing/index.html", "compare/index.html", "product/index.html", "index.html"];
let changed = [];

for (const rel of targets) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) continue;
  const original = fs.readFileSync(file, "utf8");
  let html = original;

  if (rel === "pricing/index.html") {
    html = replaceRegion(html, "cards", renderCards(plans));
    html = replaceRegion(html, "matrixhead", renderMatrixHead(plans));
    html = replaceRegion(html, "matrix", renderMatrix(plans, features));
  }
  html = fillTokens(html, { priceByKey, nameByKey, limitByKey });

  if (html !== original) {
    changed.push(rel);
    if (!CHECK) fs.writeFileSync(file, html);
  }
}

if (CHECK) {
  if (changed.length) {
    console.error("Out of date with the live plan data:\n  " + changed.join("\n  "));
    process.exit(1);
  }
  console.log("Pricing pages are in sync.");
} else {
  console.log(changed.length ? "Updated:\n  " + changed.join("\n  ") : "No changes — already in sync.");
}
