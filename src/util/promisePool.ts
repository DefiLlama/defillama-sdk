
import { PromisePool } from '@supercharge/promise-pool';
import { formError } from '../generalUtil';

export default async function runInPromisePool(params: {
  items: any[];
  concurrency: number;
  processor: any;
  permitFailure?: boolean
  withMetadata?: boolean
}) {

  const errors: any[] = []
  const { results, } = await PromisePool
    .withConcurrency(params.concurrency)
    .for(params.items)
    .process(async (item, i) => {
      try {
        if (errors.length && !params.permitFailure)
          throw new Error('Aborting, previous errors in promise pool')

        const res = await params.processor(item, i)
        return [res, i]


      } catch (e) {

        errors.push(e)
        return [undefined, i]

      }
    })

  if (errors.length && !params.permitFailure)
    throw formError(null, { promisePoolErrors: errors })

  // Preserve order of results
  const flatResults = results.sort((a, b) => a[1] - b[1]).map((i => i[0])) as any[]

  if (params.withMetadata) return { results: flatResults, errors } as any

  return flatResults;
}

export { runInPromisePool }