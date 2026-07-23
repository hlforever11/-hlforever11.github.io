const test = require("node:test");
const assert = require("node:assert/strict");
const { main } = require("../cloudfunctions/extractDocument");

const originalFetch = global.fetch;

test.afterEach(() => {
  global.fetch = originalFetch;
});

test("临时 TXT 文档可提取参考文献且最多返回二十条", async () => {
  const text = `参考文献
[1] 李书宁,刘一鸣.ChatGPT类智能对话工具兴起对图书馆行业的机遇与挑战[J].图书馆论坛,2023,43(05):104-110.
[2] RADFORD A, WU J, CHILD R, et al. Language models are unsupervised multitask learners[J]. OpenAI Blog, 2019, 1(8):9.`;
  global.fetch = async () => new Response(text, {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "content-length": String(Buffer.byteLength(text))
    }
  });

  const result = await main({
    tempUrl: "https://reference-checker.tcb.qcloud.la/temporary/test.txt",
    fileName: "test.txt"
  });
  assert.equal(result.ok, true);
  assert.equal(result.total, 2);
  assert.match(result.references[1], /RADFORD/);
});

test("文档函数拒绝读取非腾讯云临时地址", async () => {
  global.fetch = async () => {
    throw new Error("不应发起网络请求");
  };
  const result = await main({
    tempUrl: "https://example.com/private.docx",
    fileName: "private.docx"
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /临时文件地址无效/);
});

