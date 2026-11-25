const dns = require("node:dns").promises;
const http = require("node:http");
const https = require("node:https");
const ipaddr = require("ipaddr.js");
const { Parser } = require("htmlparser2");

// Inspect public pages only. Pin each connection to the address we checked,
// including after redirects. Never forward browser cookies or credentials.
async function readPage(url, signal) {
  if (!["http:", "https:"].includes(url.protocol) || url.port || url.username || url.password) throw Error();
  const { address } = await dns.lookup(url.hostname, { family: 4 });
  if (ipaddr.parse(address).range() !== "unicast" || address === "168.63.129.16") throw Error();
  const transport = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.get(url, {
      signal, agent: false, family: 4, autoSelectFamily: false,
      lookup: (_host, _options, done) => done(null, address, 4),
      headers: { Accept: "text/html,video/*;q=0.8,*/*;q=0.5", "Accept-Encoding": "identity" }
    }, res => {
      const type = (res.headers["content-type"] || "").toLowerCase();
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        try { resolve({ redirect: new URL(res.headers.location, url) }); }
        catch (error) { reject(error); }
        res.destroy();
      } else if (res.statusCode === 200 && type.includes("html")) {
        const chunks = [];
        let size = 0;
        res.on("data", chunk => {
          size += chunk.length;
          if (size > 1500000) { reject(Error()); res.destroy(); }
          else chunks.push(chunk);
        });
        res.on("end", () => resolve({ html: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      } else {
        resolve({ media: res.statusCode < 300 && (/^video\//.test(type) || type.includes("mpegurl")) });
        res.destroy();
      }
    });
    req.on("error", reject);
  });
}

function mediaInHtml(html, page) {
  const urls = [];
  let base = page;
  let videoDepth = 0;
  let json = null;
  function add(value, embed = false) {
    if (typeof value !== "string" || !value.trim()) return;
    try {
      const url = new URL(value, base);
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.href.length > 2000) return;
      if (embed && !/^(?:(?:www\.)?youtube(?:-nocookie)?\.com\/embed\/|player\.vimeo\.com\/video\/)/i.test(url.host + url.pathname)) return;
      urls.push(url.href);
    } catch {}
  }
  function structured(value, depth = 0) {
    if (!value || typeof value !== "object" || depth > 20) return;
    if ([value["@type"]].flat().includes("VideoObject")) {
      add(value.contentUrl);
      add(value.embedUrl, true);
    }
    for (const child of Object.values(value)) structured(child, depth + 1);
  }
  const parser = new Parser({
    onopentag(tag, a) {
      if (tag === "base" && a.href && base === page) { try { base = new URL(a.href, page); } catch {} }
      if (tag === "video") { videoDepth++; add(a.src); }
      if (tag === "source" && videoDepth) add(a.src);
      if (tag === "iframe") add(a.src, true);
      if (tag === "meta" && /^(og:video(:url|:secure_url)?|twitter:player:stream)$/.test(a.property || a.name)) add(a.content);
      if (tag === "script" && a.type === "application/ld+json") json = "";
    },
    ontext(text) { if (json !== null) json += text; },
    onclosetag(tag) {
      if (tag === "video") videoDepth = Math.max(0, videoDepth - 1);
      if (tag === "script" && json !== null) {
        try { structured(JSON.parse(json)); } catch {}
        json = null;
      }
    }
  });
  parser.end(html);
  return [...new Set(urls)].filter(url => url !== page.href).slice(0, 16);
}

let pending = 0;
async function resolveVideo(req, res) {
  if (pending >= 8) return res.sendStatus(429);
  pending++;
  const signal = AbortSignal.timeout(6500);
  try {
    if (typeof req.query.url !== "string" || req.query.url.length > 2000) throw Error();
    let url = new URL(req.query.url);
    for (let hop = 0; hop < 4; hop++) {
      const page = await readPage(url, signal);
      if (page.redirect) { url = page.redirect; continue; }
      return res.json({ sources: page.media ? [url.href] : mediaInHtml(page.html || "", url) });
    }
    throw Error();
  } catch {
    return res.status(422).json({ sources: [] });
  } finally { pending--; }
}
module.exports = { resolveVideo, mediaInHtml };
