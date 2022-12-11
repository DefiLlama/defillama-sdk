
import { PromisePool } from '@supercharge/promise-pool';

export default async function runInPromisePool(params: {
 items: any[];
 concurrency: number;
 processor: any;
}) {

  const { results, errors } = await PromisePool
    .withConcurrency(params.concurrency)
    .for(params.items)
    .process(async (item, i) => [await params.processor(item, i), i])

  if (errors.length)
    throw errors[0]

  const flatResults = results.sort((a, b) => a[1] - b[1]).map((i => i[0])) as any[]
  return flatResults;
}