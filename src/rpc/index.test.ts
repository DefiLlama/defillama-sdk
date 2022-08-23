import {getBalance} from "../eth";
import {callMethod} from "./index";
import {Chain} from "../general";


test("call method", async () => {
    const chains = [
        "posichain"
    ];

    await callMethod({
        params: "0x0000000000000000000000000000000000000000",
        methodRpc: "hmyv2_getValidatorInformation",
        chain: chains[0] as Chain
    })
});