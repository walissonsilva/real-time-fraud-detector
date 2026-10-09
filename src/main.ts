import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: false });
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3000, '0.0.0.0');
}

bootstrap().catch((err: unknown) => {
  // FR-014b: configuração de regras inválida (ou qualquer falha de inicialização) impede o serviço de subir.
  console.error(JSON.stringify({ level: 'error', message: 'falha na inicialização do serviço', error: (err as Error).message }));
  process.exit(1);
});
