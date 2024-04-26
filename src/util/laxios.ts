// replicate axios.post but using native nodejs library and support timeout
// Issue with axios: https://bobbyhadz.com/blog/handle-timeouts-in-axios
//  The axios timeout property is for response timeouts, not connection timeouts
import https from 'https'
import pLimit from 'p-limit'
import { getEnvValue } from './env';
import { debugLog } from './debugLog';

const limitRPCCalls = pLimit(+getEnvValue('LAXIOS_CONCURRENCY_LIMIT', '50')!);
let concurrencyCount = 0

const _post = async (url: string, data: any, config: {
  timeout?: number
} = {}): Promise<any> => {
  const timeout = config.timeout ?? 50000
  concurrencyCount++
  debugLog(`laxios count: ${concurrencyCount}`)
  return new Promise((resolve, reject) => {
    // Set a timeout to reject the promise if the request takes too long
    let responseSent = false
    const postExit = () => {
      if (timeoutId) clearTimeout(timeoutId)
      if (responseSent) return;
      responseSent = true
      concurrencyCount--
    }
    const wrappedReject = (e: any) => {
      reject(e);
      postExit()
    }
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      timeout,
    }, (res) => {
      let body = ''
      res.on('data', (chunk) => {
        body += chunk
      })
      res.on('end', () => {
        try {
          resolve({
            data: JSON.parse(body),
            status: res.statusCode,
          })
        } catch (e) {
          // if (body.startsWith('<')) reject(new Error(`Invalid JSON: ` + body.slice(0, 90)))
          const error = new Error(`Invalid JSON: ` + body.slice(0, 90))
          reject(error)
        }
        postExit()
      })
    })
    const timeoutId = setTimeout(() => {
      req.destroy();
      reject(new Error('Request timed out: ' + timeout/1e3 + 's'));
      postExit()
    }, timeout);

    req.on('error', wrappedReject)

    req.write(JSON.stringify(data))
    req.end()
  })
}

export const post = (url: string, data: any, config: any = {}): Promise<any> => limitRPCCalls(() => _post(url, data, config))