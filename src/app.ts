import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import { env } from './config/env';
import { openApiSpec } from './docs/openapi';
import { authenticate } from './middlewares/auth';
import { errorHandler, notFoundHandler } from './middlewares/errorHandler';
import { apiLimiter } from './middlewares/rateLimit';
import { assessmentRoutes, assignmentRoutes } from './routes/assessment.routes';
import { assessmentStartRoutes, attemptRoutes, resultRoutes, userRoutes } from './routes/attempt.routes';
import authRoutes from './routes/auth.routes';
import { productRoutes, topicRoutes } from './routes/product.routes';
import questionRoutes from './routes/question.routes';
import { dashboardRoutes, reportRoutes } from './routes/report.routes';
import roleRoutes from './routes/role.routes';
import { auditRoutes, notificationRoutes, settingsRoutes } from './routes/system.routes';
import usersRoutes from './routes/user.routes';

export function createApp() {
  const app = express();

  // Behind nginx / a load balancer: trust the first proxy so req.ip and rate limiting use the client IP.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    helmet({
      // Swagger UI needs inline styles/scripts on /api/docs only.
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use(
    cors({
      origin: (origin, cb) => cb(null, !origin || env.corsOrigins.includes(origin)),
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());

  app.get('/api/health', (_req, res) => res.json({ success: true, data: { status: 'ok', time: new Date().toISOString() } }));
  app.get('/api/docs.json', (_req, res) => res.json(openApiSpec));
  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openApiSpec, { customSiteTitle: 'PKT API Docs' }));

  app.use('/api', apiLimiter);
  app.use('/api/auth', authRoutes);

  // Everything below requires a valid access token.
  const api = express.Router();
  api.use(authenticate);
  api.use('/users', usersRoutes);
  api.use('/roles', roleRoutes);
  api.use('/products', productRoutes);
  api.use('/topics', topicRoutes);
  api.use('/questions', questionRoutes);
  api.use('/assessments', assessmentStartRoutes);
  api.use('/assessments', assessmentRoutes);
  api.use('/assignments', assignmentRoutes);
  api.use('/user', userRoutes);
  api.use('/attempts', attemptRoutes);
  api.use('/results', resultRoutes);
  api.use('/reports', reportRoutes);
  api.use('/dashboard', dashboardRoutes);
  api.use('/notifications', notificationRoutes);
  api.use('/settings', settingsRoutes);
  api.use('/audit-logs', auditRoutes);
  app.use('/api', api);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
