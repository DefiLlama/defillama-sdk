import { request, modifyEndpoint } from './graph';

if (!process.env.GRAPH_API_KEY)
  process.env.GRAPH_API_KEY = "123DummyKey";
const graphApiKey = process.env.GRAPH_API_KEY

test("modify graph endpoint", async () => {
  const endpoint = "https://api.thegraph.com/[api-key]/subgraphs/name/yieldyak/reinvest-tracker";
  const modifiedEndpoint = modifyEndpoint(endpoint);
  expect(modifiedEndpoint).toBe(`https://api.thegraph.com/${graphApiKey}/subgraphs/name/yieldyak/reinvest-tracker`);

  const endpoint2 = "https://api.thegraph2.com/subgraphs/name/yieldyak/reinvest-tracker";
  const modifiedEndpoint2 = modifyEndpoint(endpoint2);
  expect(modifiedEndpoint2).toBe(endpoint2);
})

test.skip("request graph data", async () => {
  const data = await request("https://api.thegraph.com/subgraphs/name/yieldyak/reinvest-tracker", "{ farms(first: 1000) { id }}");
  expect(data.farms.length).toBeGreaterThan(0);
})