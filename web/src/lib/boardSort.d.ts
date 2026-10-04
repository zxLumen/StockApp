import type { Board, BoardCategory } from '../types'

export type SortKey = 'changePct' | 'amount' | 'netInflow' | 'up' | 'name'
export type SortDir = 'asc' | 'desc'

export declare const SORT_KEYS: readonly SortKey[]
export declare const DEFAULT_SORT: Record<BoardCategory, { key: SortKey; dir: SortDir }>

/** 排序板块列表，不修改入参。缺数据的恒沉底，同值按 code 稳定排序。 */
export declare function sortBoards(list: Board[], key: SortKey, dir: SortDir): Board[]

/** 该分类下真正有数据的可排字段（`name` 恒可排）。 */
export declare function sortableKeys(sample: Board[]): Set<SortKey>

/** 该分类下在 `key` 上缺数据的板块数。 */
export declare function countMissing(list: Board[], key: SortKey): number
