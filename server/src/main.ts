import 'dotenv/config'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'
import { RealtimeService } from './realtime.service'

async function bootstrap() {
  const app = await NestFactory.create(AppModule)
  const extraOrigins = (process.env.CORS_ORIGINS ?? '').split(',').map((origin) => origin.trim()).filter(Boolean)
  app.enableCors({ origin: [/^http:\/\/localhost:\d+$/, /^http:\/\/127\.0\.0\.1:\d+$/, ...extraOrigins] })
  const port = Number(process.env.PORT) || 3002
  app.get(RealtimeService).attach(app.getHttpServer())
  await app.listen(port)
  console.log(`Game service listening on http://localhost:${port}`)
}
bootstrap()
