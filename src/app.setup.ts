import { INestApplication, ValidationPipe } from '@nestjs/common';
import { CustomerStatusMalformedRequestFilter } from './webhook/customer-status-malformed.filter';

/**
 * Application-level HTTP wiring shared by main.ts and the tests.
 *
 * The malformed-request filter is registered with useGlobalFilters (not APP_FILTER) because only
 * globally registered filters see errors raised by the Express body parser before the controller
 * runs; it audits malformed POST /customerStatus attempts without weakening JSON validation.
 */
export function configureApp(app: INestApplication): INestApplication {
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(app.get(CustomerStatusMalformedRequestFilter));
  return app;
}
