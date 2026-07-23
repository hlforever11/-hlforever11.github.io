const test = require("node:test");
const assert = require("node:assert/strict");
const {
  splitReferences,
  extractReferencesFromDocument
} = require("../miniprogram/utils/references");

test("连续粘贴的中英文混合内容可识别为六条参考文献", () => {
  const value = `[1] 李书宁,刘一鸣.ChatGPT类智能对话工具兴起对图书馆行业的机遇与挑战[J].图书馆论坛,2023,43(05):104-110. [2] 曹树金,曹茹烨.从ChatGPT看生成式AI对情报学研究与实践的影响[J].现代情报,2023,43(04):3-10. [3] 陈金榜.朱民博士畅谈ChatGPT与人工智能未来[EB/OL].(2023-03-13)[2023-04-18]. https://www.shanghaitech.edu.cn/2023/0313/c1001a1075770/page.htm.
Sinkinson, C. (2019). Reflective practice for librarians and teachers. In S. Hines & M. Wakimoto (Eds.), Instructional technologies in libraries: Practice, implementation, and management (pp. 14–28). ALA Editions.
UNESCO. (2021). Recommendation on the ethics of artificial intelligence. United Nations Educational, Scientific and Cultural Organization. https://unesdoc.unesco.org/ark:/48223/pf0000381137
Veletsianos, G., & Houlden, S. (2020). An analysis of flexible learning and flexibility over the last 40 years of Distance Education. Distance Education, 41(4), 471–487. https://doi.org/10.1080/01587919.2020.1821966`;

  const references = splitReferences(value);
  assert.equal(references.length, 6);
  assert.match(references[0], /李书宁/);
  assert.match(references[5], /Veletsianos/);
});

test("文档参考文献标题后的多行条目可正确合并", () => {
  const value = `正文内容

参考文献
[1] 李书宁,刘一鸣.ChatGPT类智能对话工具兴起
对图书馆行业的机遇与挑战[J].图书馆论坛,2023,43(05):104-110.
[2] 陈金榜.朱民博士畅谈ChatGPT与人工智能未来[EB/OL].
(2023-03-13)[2023-04-18]. https://www.shanghaitech.edu.cn/example`;
  const references = extractReferencesFromDocument(value);
  assert.equal(references.length, 2);
  assert.match(references[0], /机遇与挑战/);
  assert.match(references[1], /shanghaitech/);
});

