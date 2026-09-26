import 'dotenv/config'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'
import { RealtimeService } from './realtime.service'

async function bootstrap() {
  const app = await NestFactory.create(AppModule)
  // Any page may call the API unless CORS_ORIGINS narrows it: logins travel as a Bearer token the page adds
  // itself (no cookies), so another site can't borrow a player's session through the browser.
  const allowed = (process.env.CORS_ORIGINS ?? '').split(',').map((origin) => origin.trim()).filter(Boolean)
  app.enableCors({ origin: allowed.length ? [/^http:\/\/localhost:\d+$/, /^http:\/\/127\.0\.0\.1:\d+$/, ...allowed] : true })
  const port = Number(process.env.PORT) || 3002
  app.get(RealtimeService).attach(app.getHttpServer())
  await app.listen(port)
  console.log(`Game service listening on http://localhost:${port}`)
}
bootstrap()
