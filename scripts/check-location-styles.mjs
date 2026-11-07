import assert from "node:assert/strict";

const base = new URL(process.argv[2] || "http://127.0.0.1:3128");
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(base.hostname), "Use a local preview URL");
const response = await fetch(new URL("/locations", base));
assert.equal(response.status, 200);
const html = await response.text();
const assets = [...html.matchAll(/href="([^\"]+\.css(?:\?[^\"]*)?)"/g)].map(match => match[1]);
assert.ok(assets.length, "No CSS assets linked");
const css = (await Promise.all(assets.map(async asset => {
  const response = await fetch(new URL(asset.replaceAll("&amp;", "&"), base));
  assert.equal(response.status, 200, `CSS failed to load: ${asset}`);
  return response.text();
}))).join("\n");

function styledClass(tag, rule) {
  assert.ok(tag, "Missing expected element");
  const className = tag.match(/class="([^\"]+)"/)?.[1];
  assert.ok(className, `Missing CSS Modules class on ${tag}`);
  const matched = className.split(/\s+/).some(name => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return [...css.matchAll(new RegExp(`\\.${escaped}\\s*\\{([^}]+)\\}`, "g"))].some(match => rule.test(match[1]));
  });
  assert.ok(matched, `No matching CSS layout rule for ${className}`);
}

styledClass(html.match(/<main\b[^>]*>/)?.[0], /min-height:\s*100dvh/);
styledClass(html.match(/<header\b[^>]*>/)?.[0], /display:\s*flex/);
styledClass(html.match(/<svg\b[^>]*>/)?.[0], /max-width:\s*240px/);
const workspace = [...html.matchAll(/<div\b[^>]*>/g)].map(match => match[0]).find(tag => /class="[^\"]*workspace/.test(tag));
styledClass(workspace, /display:\s*grid/);
const locationButton = html.match(/<button\b[^>]*aria-pressed="false"[^>]*>/)?.[0];
styledClass(locationButton, /display:\s*flex/);
assert.ok(/@media\s*\(\s*(?:max-width:\s*760px|width\s*<=\s*760px)\s*\)/.test(css), "Mobile breakpoint missing");
assert.ok(css.includes(".brand-icon"), "Shared branding CSS missing");
console.log(`PASS ${base.origin}: CSS Modules classes match served layout rules; desktop grid, SVG sizing, mobile breakpoint and global branding present.`);
