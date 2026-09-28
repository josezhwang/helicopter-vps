import { Injectable, Logger } from '@nestjs/common'

/** Discord embed colours: the teams, and neutral news. */
export const DISCORD_COLOR = { red: 0xff5a4e, blue: 0x4f9dff, news: 0x3ee0c8, gold: 0xffc53d } as const

interface Embed {
  title: string
  description?: string
  url?: string
  color?: number
  fields?: Array<{ name: string; value: string; inline?: boolean }>
}

/** Discord allows a few posts a second per webhook; stay well under its per-minute channel limit too. */
const MAX_PER_MINUTE = 20

/**
 * Optional Discord announcements. With DISCORD_WEBHOOK_URL set in server/.env, new battles (with a join link),
 * battle starts, killing sprees and results are posted to that Discord channel. Without it nothing is sent.
 * PUBLIC_SITE_URL (the address players open the game at) makes the join links; without it the address the
 * room was created from is used.
 */
@Injectable()
export class DiscordService {
  private readonly logger = new Logger('Discord')
  private readonly webhook = (process.env.DISCORD_WEBHOOK_URL ?? '').trim()
  private readonly site = (process.env.PUBLIC_SITE_URL ?? '').trim().replace(/\/+$/, '')
  /** Posts go out one after another. */
  private queue: Promise<void> = Promise.resolve()
  private recent: number[] = []

  get enabled() {
    return /^https:\/\/(?:[a-z]+\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(this.webhook)
  }

  /** Where friends join a room (the game's own link), or '' when we don't know the site's address. */
  roomLink(roomId: string, origin?: string) {
    const site = this.site || (origin && /^https?:\/\/[^\s/]+$/.test(origin) ? origin : '')
    return site ? `${site}/#/room/${roomId}` : ''
  }

  /** Post one message (dropped quietly when Discord isn't set up or we're posting too fast). */
  post(embed: Embed, content?: string) {
    if (!this.enabled) return
    const now = Date.now()
    this.recent = this.recent.filter((t) => now - t < 60_000)
    if (this.recent.length >= MAX_PER_MINUTE) return
    this.recent.push(now)
    const body = JSON.stringify({ username: 'Aerium Command', content, embeds: [{ ...embed, timestamp: new Date().toISOString() }], allowed_mentions: { parse: [] } })
    this.queue = this.queue.then(async () => {
      try {
        const response = await fetch(`${this.webhook}?wait=false`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(8000) })
        if (!response.ok) this.logger.warn(`Discord said ${response.status} ${response.statusText}`)
      } catch (error) {
        this.logger.warn(`Could not reach Discord: ${(error as Error).message}`)
      }
    })
  }
}

/** Keep names from pinging or formatting in Discord. */
export const plain = (text: string) => text.replace(/[*_~`|>@#]/g, '').slice(0, 64)
