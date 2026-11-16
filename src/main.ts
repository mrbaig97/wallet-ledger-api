import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { text, type RequestHandler } from 'express';
import { AppModule } from './app.module';
import { bearerAuth, HttpErrorFilter } from './http';

async function bootstrap() {
  const token = process.env.API_TOKEN;
  if (!token || /[^!-~]|,/.test(token)) {
    throw new Error('API_TOKEN must be set to a valid bearer token.');
  }

  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  const parseText = text({ type: 'application/json', limit: '1mb' });
  const parseBody: RequestHandler = (request, response, next) => {
    if (request.method !== 'POST') return next();
    parseText(request, response, (error?: unknown) => {
      if (error) {
        response.status(400).json({ error: 'invalid_request', message: 'Invalid JSON request body.' });
        return;
      }
      next();
    });
  };
  app.use(bearerAuth(token), parseBody);
  app.useGlobalFilters(new HttpErrorFilter());
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 8080), '0.0.0.0');
  const address = app.getHttpServer().address() as { port: number };
  console.log('Wallet API listening on port ' + address.port);
}

void bootstrap().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});
