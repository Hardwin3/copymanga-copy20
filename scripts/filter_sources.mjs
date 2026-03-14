#!/usr/bin/env node
/**
 * 过滤漫画源索引，移除 18+ 扩展和不可访问的源
 * 由 GitHub Actions 调用，输出过滤后的 index.min.json 和 index.json
 */

import { readFileSync, writeFileSync } from "fs";
import https from "https";
import http from "http";

const TIMEOUT = 15000;

function checkUrl(url) {
  return new Promise((resolve) => {
    const cleanUrl = url.replace(/\/+$/, "");
    const mod = cleanUrl.startsWith("https") ? https : http;
    const req = mod.get(
      cleanUrl,
      {
        timeout: TIMEOUT,
        headers: { "User-Agent": "Mozilla/5.0 (compatible; MihonRepoChecker/1.0)" },
      },
      (res) => {
        res.resume();
        res.on("end", () => {
          resolve({
            url: cleanUrl,
            accessible: res.statusCode >= 200 && res.statusCode < 400,
            status: res.statusCode,
          });
        });
      }
    );
    req.on("error", () => resolve({ url: cleanUrl, accessible: false, status: 0 }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ url: cleanUrl, accessible: false, status: 0 });
    });
  });
}

async function main() {
  const inputFile = process.argv[2] || "index.min.json";
  console.log(`读取索引: ${inputFile}`);

  const extensions = JSON.parse(readFileSync(inputFile, "utf-8"));
  console.log(`共 ${extensions.length} 个扩展\n`);

  // 过滤 18+ 扩展 (nsfw > 0)
  const nsfwRemoved = extensions.filter(e => (e.nsfw || 0) > 0);
  if (nsfwRemoved.length > 0) {
    console.log(`移除 ${nsfwRemoved.length} 个 18+ 扩展:`);
    nsfwRemoved.forEach(e => console.log(`  - ${e.name} (nsfw=${e.nsfw})`));
  }
  const sfwExtensions = extensions.filter(e => (e.nsfw || 0) === 0);
  console.log(`剩余 ${sfwExtensions.length} 个扩展，开始检测可用性...\n`);

  // 收集所有 URL
  const checks = [];
  for (let i = 0; i < sfwExtensions.length; i++) {
    const ext = sfwExtensions[i];
    for (let j = 0; j < (ext.sources || []).length; j++) {
      const src = ext.sources[j];
      if (src.baseUrl) {
        checks.push({ extIdx: i, srcIdx: j, url: src.baseUrl, name: src.name || ext.name });
      }
    }
  }

  console.log(`检测 ${checks.length} 个源...\n`);

  // 并发检测 (每批 5 个)
  const results = new Map();
  for (let i = 0; i < checks.length; i += 5) {
    const batch = checks.slice(i, i + 5);
    const batchResults = await Promise.all(batch.map(async (check) => {
      const result = await checkUrl(check.url);
      return { ...check, ...result };
    }));
    for (const r of batchResults) {
      results.set(`${r.extIdx}-${r.srcIdx}`, r);
      console.log(`  [${r.accessible ? "OK" : "FAIL"}] ${r.name} (${r.url}) - HTTP ${r.status}`);
    }
  }

  // 过滤不可访问的源
  const available = [];
  let removedCount = 0;

  for (let i = 0; i < sfwExtensions.length; i++) {
    const ext = sfwExtensions[i];
    const newSources = [];
    for (let j = 0; j < (ext.sources || []).length; j++) {
      const r = results.get(`${i}-${j}`);
      if (r && r.accessible) {
        newSources.push(ext.sources[j]);
      } else {
        removedCount++;
      }
    }
    if (newSources.length > 0) {
      available.push({ ...ext, sources: newSources });
    }
  }

  console.log(`\n可用: ${available.length}/${extensions.length} 扩展, 移除 ${removedCount} 个不可访问源`);

  // 写入
  writeFileSync("index.min.json", JSON.stringify(available), "utf-8");
  writeFileSync("index.json", JSON.stringify(available, null, 2), "utf-8");
  console.log("已更新 index.min.json 和 index.json");
}

main().catch(console.error);
