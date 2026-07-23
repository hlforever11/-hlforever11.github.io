const test = require("node:test");
const assert = require("node:assert/strict");
const dns = require("node:dns").promises;
const {
  verifyReference,
  parseReference
} = require("../cloudfunctions/verifyReference/lib/core");

const originalFetch = global.fetch;
const originalLookup = dns.lookup;

test.afterEach(() => {
  global.fetch = originalFetch;
  dns.lookup = originalLookup;
});

test("可解析 OpenAI Blog 灰色文献的关键字段", () => {
  const parsed = parseReference(
    "RADFORD A, WU J, CHILD R, et al. Language models are unsupervised multitask learners[J]. OpenAI Blog, 2019, 1(8): 9."
  );
  assert.equal(parsed.title, "Language models are unsupervised multitask learners");
  assert.equal(parsed.container, "OpenAI Blog");
  assert.equal(parsed.year, 2019);
  assert.equal(parsed.volume, "1");
  assert.equal(parsed.issue, "8");
  assert.equal(parsed.pages, "9");
});

test("Crossref 和 OpenAlex 未收录时可由 Semantic Scholar 确认英文灰色文献", async () => {
  global.fetch = async (input) => {
    const url = String(input);
    if (url.includes("api.crossref.org")) {
      return new Response(JSON.stringify({ message: { items: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (url.includes("api.openalex.org")) {
      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (url.includes("api.semanticscholar.org")) {
      return new Response(JSON.stringify({
        data: [{
          paperId: "radford-2019",
          title: "Language Models are Unsupervised Multitask Learners",
          authors: [
            { name: "Alec Radford" },
            { name: "Jeff Wu" },
            { name: "Rewon Child" },
            { name: "Ilya Sutskever" }
          ],
          year: 2019,
          venue: "OpenAI Blog",
          publicationTypes: ["Review"],
          externalIds: {},
          url: "https://www.semanticscholar.org/paper/radford-2019"
        }]
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    throw new Error(`Unexpected URL ${url}`);
  };

  const result = await verifyReference(
    "RADFORD A, WU J, CHILD R, et al. Language models are unsupervised multitask learners[J]. OpenAI Blog, 2019, 1(8): 9."
  );
  assert.ok(["verified", "partial"].includes(result.status));
  assert.ok(result.confidence >= 0.8);
  assert.match(result.source, /Semantic Scholar/);
});

test("网页文献可由原始页面题名、作者和日期确认", async () => {
  dns.lookup = async () => [{ address: "8.8.8.8", family: 4 }];
  global.fetch = async (input) => {
    const url = String(input);
    if (!url.includes("shanghaitech.edu.cn")) throw new Error(`Unexpected URL ${url}`);
    const html = `<!doctype html><html><head>
      <meta property="og:title" content="朱民博士畅谈ChatGPT与人工智能未来">
      <meta name="author" content="陈金榜">
      <meta property="article:published_time" content="2023-03-13">
      <meta property="og:site_name" content="上海科技大学">
      </head><body><h1>朱民博士畅谈ChatGPT与人工智能未来</h1></body></html>`;
    return new Response(html, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" }
    });
  };

  const result = await verifyReference(
    "[3] 陈金榜.朱民博士畅谈ChatGPT与人工智能未来[EB/OL].(2023-03-13)[2023-04-18]. https://www.shanghaitech.edu.cn/2023/0313/c1001a1075770/page.htm"
  );
  assert.equal(result.status, "verified");
  assert.ok(result.confidence >= 0.85);
  assert.equal(result.differences.length, 0);
});

test("网页核验拒绝访问私网和本机地址", async () => {
  global.fetch = async () => {
    throw new Error("不应发起网络请求");
  };
  const result = await verifyReference(
    "测试作者.测试页面[EB/OL].(2024-01-01)[2024-02-01]. http://127.0.0.1/internal"
  );
  assert.equal(result.status, "unverified");
  assert.match(result.note, /非公开网络地址/);
});
