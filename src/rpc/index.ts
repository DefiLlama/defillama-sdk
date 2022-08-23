import {Chain, chainInfo, getProvider, handleDecimals} from "../general";
import axios from "axios";

export async function callMethod(params: {
    params: any;
    methodRpc: string;
    chain: Chain;
}) {

    const client = axios.create({
        baseURL: chainInfo.posichain.rpc[0],
        headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
        },
    });

    const response = await client.post('/', bodyParams(params.methodRpc, params.params));
    if (response === null || response.data === null || response.data.result === null) {
        return {output : null}
    }
    return {
        output: response.data.result,
    };
}

export const bodyParams = (method: string, params?: string | number) => `{
      "jsonrpc": "2.0",
      "method": "${method}",
      "params": ${params !== undefined ? `["${params}"]` : '[]'},
      "id": 1
    }`;