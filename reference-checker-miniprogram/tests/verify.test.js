const test = require("node:test");
const assert = require("node:assert/strict");
const dns = require("node:dns").promises;
const {
  verifyReference,
  parseReference,
  buildVerificationPlan
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

test("按 DOI、ISBN、PMID、arXiv 及不同文献类型选择核验来源", () => {
  const doi = parseReference(
    "作者. 论文题名[J]. 期刊, 2024, 1(1):1-8. DOI:10.1000/example."
  );
  assert.ok(buildVerificationPlan(doi).includes("doi-registry"));

  const book = parseReference(
    "作者. 图书题名[M]. 北京: 出版社, 2022. ISBN 978-7-000-00000-0."
  );
  assert.equal(book.isbn, "9787000000000");
  assert.ok(buildVerificationPlan(book).includes("open-library"));

  const pubmed = parseReference(
    "Author. Medical article[J]. Journal, 2021. PMID: 34567890."
  );
  assert.equal(pubmed.pmid, "34567890");
  assert.ok(buildVerificationPlan(pubmed).includes("pubmed"));

  const preprint = parseReference(
    "Author. Preprint title[R/OL]. arXiv:2406.14491."
  );
  assert.equal(preprint.arxivId, "2406.14491");
  assert.ok(buildVerificationPlan(preprint).includes("arxiv"));

  const standard = parseReference(
    "国家标准化管理委员会. 信息技术标准[S]. GB/T 12345-2024."
  );
  assert.equal(standard.standardNumber, "GB/T 12345-2024");
  assert.ok(buildVerificationPlan(standard).includes("search-engine"));
  assert.ok(!buildVerificationPlan(standard).includes("crossref"));

  const conference = parseReference(
    "张三.会议论文题名[C]//全国学术会议论文集.北京:出版社,2022:10-20."
  );
  assert.ok(buildVerificationPlan(conference).includes("crossref"));
  assert.ok(buildVerificationPlan(conference).includes("openalex"));

  const dissertation = parseReference(
    "李四.人工智能研究[D].成都:四川大学,2023."
  );
  assert.ok(buildVerificationPlan(dissertation).includes("openalex"));

  const patent = parseReference(
    "王五.一种知识核验方法[P].中国专利:CN115123456A,2022-09-01."
  );
  assert.equal(patent.patentNumber, "CN115123456A");
  assert.deepEqual(buildVerificationPlan(patent), ["search-engine"]);

  const newspaper = parseReference(
    "赵六.人工智能赋能图书馆[N].光明日报,2024-01-02(08)."
  );
  assert.deepEqual(buildVerificationPlan(newspaper), ["search-engine"]);

  const dataset = parseReference(
    "机构.开放科学数据集[DB/OL].(2024-01-01)[2024-02-01].https://example.org/data"
  );
  assert.deepEqual(buildVerificationPlan(dataset), ["search-engine"]);
});

test("OpenAI 官方来源可确认英文技术报告并修正文献类型", async () => {
  const result = await verifyReference(
    "RADFORD A, WU J, CHILD R, et al. Language models are unsupervised multitask learners[J]. OpenAI Blog, 2019, 1(8): 9."
  );
  assert.equal(result.status, "corrected");
  assert.ok(result.confidence >= 0.8);
  assert.match(result.source, /OpenAI 官方报告/);
  assert.ok(result.differences.some((item) => item.field === "文献类型"));
  assert.match(result.canonical, /\[R\/OL\]/);
  assert.doesNotMatch(result.canonical, /1\(8\)/);
  assert.match(result.canonical, /cdn\.openai\.com/);
});

test("UNESCO 伦理建议书可由已核对官方记录确认，不依赖境外页面实时响应", async () => {
  global.fetch = async () => {
    throw new Error("已核对记录不应发起外部请求");
  };

  const result = await verifyReference(
    "UNESCO. (2021). Recommendation on the ethics of artificial intelligence. United Nations Educational, Scientific and Cultural Organization. https://unesdoc.unesco.org/ark:/48223/pf0000381137"
  );
  assert.equal(result.status, "verified");
  assert.ok(result.confidence >= 0.9);
  assert.match(result.source, /UNESCO 官方文献记录/);
  assert.match(result.sourceUrl, /pf0000381137/);
  assert.match(result.canonical, /\[R\/OL\]/);
  assert.equal(result.differences.length, 0);
});

test("权威记录缓存不能替错误网址背书", async () => {
  dns.lookup = async () => [{ address: "8.8.8.8", family: 4 }];
  global.fetch = async () => new Response(
    "<!doctype html><html><head><title>Unrelated page</title></head><body></body></html>",
    {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" }
    }
  );

  const result = await verifyReference(
    "UNESCO. (2021). Recommendation on the ethics of artificial intelligence. United Nations Educational, Scientific and Cultural Organization. https://example.com/not-the-unesco-record"
  );
  assert.notEqual(result.status, "verified");
  assert.doesNotMatch(result.source || "", /UNESCO 官方文献记录/);
});

test("其他 UNESDOC ARK 文献可通过 UNESCO 官方目录核验", async () => {
  global.fetch = async (input) => {
    const url = String(input);
    if (url.includes("data.unesco.org/api/explore")) {
      return new Response(JSON.stringify({
        results: [{
          title: "Guidance for generative AI in education and research",
          creator: "UNESCO",
          year: "2023",
          description: "Published in 2023",
          url: "https://unesdoc.unesco.org/ark:/48223/pf0000386693",
          ref_code: "ED-2023/WS/4"
        }]
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    throw new Error(`Unexpected URL ${url}`);
  };

  const result = await verifyReference(
    "UNESCO. (2023). Guidance for generative AI in education and research. United Nations Educational, Scientific and Cultural Organization. https://unesdoc.unesco.org/ark:/48223/pf0000386693"
  );
  assert.equal(result.status, "verified");
  assert.ok(result.confidence >= 0.9);
  assert.match(result.source, /UNESCO DataHub/);
  assert.match(result.canonical, /\[R\/OL\]/);
});

test("《图书馆论坛》官网索引可确认中文期刊且期号 05 与 5 等价", async () => {
  const result = await verifyReference(
    "李书宁,刘一鸣.ChatGPT类智能对话工具兴起对图书馆行业的机遇与挑战[J].图书馆论坛,2023,43(05):104-110."
  );
  assert.equal(result.status, "verified");
  assert.ok(result.confidence >= 0.9);
  assert.match(result.source, /图书馆论坛/);
  assert.equal(result.differences.length, 0);
});

test("年份、卷期页和文献类型错误只影响著录准确性，不降低真实性置信度", async () => {
  const correct = await verifyReference(
    "李书宁,刘一鸣.ChatGPT类智能对话工具兴起对图书馆行业的机遇与挑战[J].图书馆论坛,2023,43(05):104-110."
  );
  const inaccurate = await verifyReference(
    "李书宁,刘一鸣.ChatGPT类智能对话工具兴起对图书馆行业的机遇与挑战[R].图书馆论坛,2022,43(99):1-2."
  );

  assert.equal(inaccurate.status, "corrected");
  assert.equal(inaccurate.confidence, correct.confidence);
  assert.equal(inaccurate.authenticityConfidence, correct.authenticityConfidence);
  assert.deepEqual(
    inaccurate.differences.map((item) => item.field).sort(),
    ["年份", "文献类型", "期号", "页码"].sort()
  );
  assert.match(inaccurate.note, /不降低真实性置信度/);
});

test("篇名相同但作者和来源均不支持时不得自动确认真实", async () => {
  const result = await verifyReference(
    "张三. ChatGPT类智能对话工具兴起对图书馆行业的机遇与挑战[J].虚构期刊,2023,43(05):104-110."
  );

  assert.ok(result.confidence < 0.67);
  assert.equal(result.status, "unverified");
});

test("中文期刊可由搜索引擎结果摘要确认存在", async () => {
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
    if (url.includes("baidu.com/s")) {
      const html = `<!doctype html><html><body>
        <div class="result c-container" mu="https://example.edu.cn/article/2024/101">
          <h3><a href="https://www.baidu.com/link?url=official">生成式人工智能环境下的高校知识服务研究</a></h3>
          <p>张三，李四．知识服务研究，2024，12(03)：20-28</p>
        </div>
      </body></html>`;
      return new Response(html, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" }
      });
    }
    throw new Error(`Unexpected URL ${url}`);
  };

  const result = await verifyReference(
    "张三,李四.生成式人工智能环境下的高校知识服务研究[J].知识服务研究,2024,12(03):20-28."
  );
  assert.equal(result.status, "partial");
  assert.ok(result.confidence >= 0.8);
  assert.match(result.source, /搜索引擎/);
  assert.match(result.sourceUrl, /example\.edu\.cn/);
  assert.ok(result.authenticityBasis.includes("作者信息支持"));
  assert.ok(result.authenticityBasis.includes("来源信息支持"));
});

test("核验源超时时返回暂未核实而不是核验失败", async () => {
  global.fetch = async () => {
    const error = new Error("request aborted");
    error.name = "AbortError";
    throw error;
  };

  const result = await verifyReference(
    "测试作者.暂未被开放数据库收录的文章[J].测试期刊,2024,1(1):1-3."
  );
  assert.equal(result.status, "unverified");
  assert.doesNotMatch(result.note, /核验失败/);
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
