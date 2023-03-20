import { debugLog, debugTable } from "./util/debugLog"

export { ChainApi } from './ChainApi'
export * as util from "./generalUtil";
export * as api from "./api";
export * as api2 from "./api2";
export * as blocks from "./computeTVL/blocks";
import * as humanN from "./computeTVL/humanizeNumber";

export const log = debugLog
export const logTable = debugTable
export const humanizeNumber = humanN.humanizeNumber