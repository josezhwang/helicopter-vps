import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'

async function bootstrap() {
  const app = await NestFactory.create(AppModule)
  app.enableCors({ origin: ['http://localhost:5173'] })
  await app.listen(3001)
  console.log('Game service listening on http://localhost:3001')
}
bootstrap()
