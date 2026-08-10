import type { PixivCrawlerApi } from '../shared/ipc-contract'

declare global { interface Window { pixivCrawler: PixivCrawlerApi } }
export {}
