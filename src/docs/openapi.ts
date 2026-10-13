/**
 * OpenAPI 3 description of the PKT API, served at /api/docs.
 * Request bodies mirror the zod validators in src/validators.
 */
type Schema = Record<string, unknown>;

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: Schema) => ({ 'application/json': { schema } });
const idParam = (name = 'id') => ({ name, in: 'path', required: true, schema: { type: 'string', format: 'uuid' } });
const q = (name: string, schema: Schema = { type: 'string' }, description?: string) => ({ name, in: 'query', schema, ...(description ? { description } : {}) });
const pageParams = [
  q('page', { type: 'integer', default: 1 }),
  q('pageSize', { type: 'integer', default: 20, maximum: 200 }),
  q('search'),
  q('sortBy'),
  q('sortOrder', { type: 'string', enum: ['asc', 'desc'] }),
];

const ok = (description: string, data: Schema = { type: 'object' }) => ({
  description,
  content: json({ allOf: [ref('Success'), { type: 'object', properties: { data } }] }),
});
const okPage = (description: string, item: Schema) => ({
  description,
  content: json({ allOf: [ref('Paginated'), { type: 'object', properties: { data: { type: 'array', items: item } } }] }),
});
const errors = {
  400: { description: 'Validation or business rule error', content: json(ref('Error')) },
  401: { description: 'Not authenticated', content: json(ref('Error')) },
  403: { description: 'Not permitted', content: json(ref('Error')) },
  404: { description: 'Not found', content: json(ref('Error')) },
};

function op(tag: string, summary: string, opts: { params?: unknown[]; body?: Schema; response?: unknown; description?: string; permission?: string } = {}) {
  return {
    tags: [tag],
    summary,
    description: [opts.description, opts.permission ? `**Permission:** \`${opts.permission}\`` : null].filter(Boolean).join('\n\n') || undefined,
    parameters: opts.params,
    requestBody: opts.body ? { required: true, content: json(opts.body) } : undefined,
    responses: { 200: opts.response ?? ok('OK'), ...errors },
  };
}

const optionInput = { type: 'object', required: ['optionText', 'isCorrect'], properties: { optionText: { type: 'string' }, isCorrect: { type: 'boolean' } } };

export const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'PKT - Product Knowledge Test Platform API',
    version: '1.0.0',
    description:
      'REST API for product-wise MCQ assessments.\n\n' +
      '1. `POST /api/auth/login` to obtain an access token (the refresh token is set as an httpOnly cookie).\n' +
      '2. Click **Authorize** and paste the access token.\n\n' +
      'All responses use `{ success, data, message }`; errors use `{ success: false, error: { code, message } }`.',
  },
  servers: [{ url: '/' }],
  security: [{ bearerAuth: [] }],
  tags: [
    { name: 'Authentication' }, { name: 'Users' }, { name: 'Roles' }, { name: 'Products' }, { name: 'Topics' },
    { name: 'Questions' }, { name: 'Assessments' }, { name: 'Assignments' }, { name: 'Learner' }, { name: 'Attempts' },
    { name: 'Reports' }, { name: 'Dashboard' }, { name: 'Notifications' }, { name: 'Settings' }, { name: 'Audit' },
  ],
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
    schemas: {
      Success: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: {}, message: { type: 'string' } } },
      Paginated: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: true },
          data: { type: 'array', items: {} },
          pagination: {
            type: 'object',
            properties: { page: { type: 'integer' }, pageSize: { type: 'integer' }, total: { type: 'integer' }, totalPages: { type: 'integer' } },
          },
        },
      },
      Error: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: false },
          error: {
            type: 'object',
            properties: { code: { type: 'string', example: 'ASSESSMENT_EXPIRED' }, message: { type: 'string', example: 'This assessment has expired.' }, details: {} },
          },
        },
      },
      LoginRequest: { type: 'object', required: ['identifier', 'password'], properties: { identifier: { type: 'string', example: 'admin@pkt.local' }, password: { type: 'string', example: 'Admin@123' } } },
      User: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' }, employeeId: { type: 'string' }, firstName: { type: 'string' }, lastName: { type: 'string' },
          email: { type: 'string' }, department: { type: 'string' }, team: { type: 'string' }, location: { type: 'string' },
          role: { type: 'object', properties: { code: { type: 'string' }, name: { type: 'string' } } }, status: { type: 'string', enum: ['ACTIVE', 'INACTIVE'] },
        },
      },
      UserInput: {
        type: 'object',
        required: ['employeeId', 'firstName', 'lastName', 'email', 'roleId'],
        properties: {
          employeeId: { type: 'string' }, firstName: { type: 'string' }, lastName: { type: 'string' }, email: { type: 'string' }, mobile: { type: 'string' },
          department: { type: 'string' }, designation: { type: 'string' }, team: { type: 'string' }, productGroup: { type: 'string' }, location: { type: 'string' },
          managerId: { type: 'string', format: 'uuid' }, roleId: { type: 'string', format: 'uuid' }, password: { type: 'string' },
          productIds: { type: 'array', items: { type: 'string', format: 'uuid' }, description: 'Products managed (Product Admin only)' },
        },
      },
      Product: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' }, productCode: { type: 'string', example: 'VAANI' }, productName: { type: 'string' },
          description: { type: 'string' }, category: { type: 'string' }, productOwner: { type: 'string' }, status: { type: 'string', enum: ['ACTIVE', 'INACTIVE'] },
        },
      },
      ProductInput: {
        type: 'object',
        required: ['productCode', 'productName'],
        properties: { productCode: { type: 'string' }, productName: { type: 'string' }, description: { type: 'string' }, category: { type: 'string' }, productOwner: { type: 'string' }, status: { type: 'string', enum: ['ACTIVE', 'INACTIVE'] } },
      },
      TopicInput: {
        type: 'object',
        required: ['productId', 'name'],
        properties: { productId: { type: 'string', format: 'uuid' }, parentId: { type: 'string', format: 'uuid', nullable: true }, name: { type: 'string' }, description: { type: 'string' }, sequence: { type: 'integer' } },
      },
      QuestionInput: {
        type: 'object',
        required: ['productId', 'topicId', 'questionText', 'options'],
        properties: {
          productId: { type: 'string', format: 'uuid' }, topicId: { type: 'string', format: 'uuid' }, subTopicId: { type: 'string', format: 'uuid', nullable: true },
          questionText: { type: 'string' }, questionType: { type: 'string', enum: ['MCQ_SINGLE'] }, difficultyLevel: { type: 'string', enum: ['EASY', 'MEDIUM', 'HARD'] },
          marks: { type: 'number', default: 1 }, negativeMarks: { type: 'number', default: 0 }, explanation: { type: 'string' },
          status: { type: 'string', enum: ['DRAFT', 'ACTIVE', 'INACTIVE'] }, options: { type: 'array', minItems: 2, maxItems: 6, items: optionInput },
        },
      },
      AssessmentInput: {
        type: 'object',
        required: ['assessmentName', 'productId'],
        properties: {
          assessmentCode: { type: 'string' }, assessmentName: { type: 'string' }, description: { type: 'string' }, instructions: { type: 'string' },
          productId: { type: 'string', format: 'uuid' }, selectionMode: { type: 'string', enum: ['MANUAL', 'DYNAMIC'] },
          passingPercentage: { type: 'number' }, durationMinutes: { type: 'integer' }, startDate: { type: 'string', format: 'date-time' }, endDate: { type: 'string', format: 'date-time' },
          maxAttempts: { type: 'integer' }, reattemptPolicy: { type: 'string', enum: ['ALWAYS', 'ONLY_IF_FAILED'] }, reattemptSameQuestions: { type: 'boolean' },
          randomizeQuestions: { type: 'boolean' }, randomizeOptions: { type: 'boolean' }, allowPreviousQuestion: { type: 'boolean' }, allowQuestionNavigation: { type: 'boolean' },
          showResultImmediately: { type: 'boolean' }, showCorrectAnswers: { type: 'boolean' }, showExplanation: { type: 'boolean' },
          negativeMarkingEnabled: { type: 'boolean' }, autoSubmitOnTimeout: { type: 'boolean' }, certificationEnabled: { type: 'boolean' }, certificationValidityDays: { type: 'integer' },
          questionIds: { type: 'array', items: { type: 'string', format: 'uuid' }, description: 'MANUAL mode' },
          rules: {
            type: 'array',
            description: 'DYNAMIC mode',
            items: { type: 'object', properties: { topicId: { type: 'string', format: 'uuid' }, subTopicId: { type: 'string', format: 'uuid' }, difficultyLevel: { type: 'string', enum: ['EASY', 'MEDIUM', 'HARD'] }, questionCount: { type: 'integer' } } },
          },
          difficultyDistribution: { type: 'object', properties: { EASY: { type: 'integer' }, MEDIUM: { type: 'integer' }, HARD: { type: 'integer' } } },
        },
      },
      AssignmentInput: {
        type: 'object',
        required: ['assessmentId', 'targets'],
        properties: {
          assessmentId: { type: 'string', format: 'uuid' },
          targets: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                assignmentType: { type: 'string', enum: ['USER', 'TEAM', 'DEPARTMENT', 'ROLE', 'PRODUCT_GROUP', 'LOCATION'] },
                assignmentReference: { type: 'string', description: 'User id, team/department/location/product-group name, or role code' },
              },
            },
          },
          dueDate: { type: 'string', format: 'date-time' },
          notify: { type: 'boolean', default: true },
        },
      },
      AttachmentInput: {
        type: 'object',
        required: ['attachmentType', 'url'],
        properties: {
          attachmentType: { type: 'string', enum: ['IMAGE', 'AUDIO', 'VIDEO', 'DOCUMENT', 'LINK'] },
          url: { type: 'string', example: 'https://example.com/diagram.png' },
          caption: { type: 'string' },
          sequence: { type: 'integer' },
        },
      },
      BandInput: {
        type: 'object',
        required: ['label', 'min', 'max'],
        properties: { label: { type: 'string', example: 'Strong' }, min: { type: 'number', example: 80 }, max: { type: 'number', example: 100 }, color: { type: 'string', example: '#0ca30c' } },
      },
      AttemptQuestion: {
        type: 'object',
        description: 'Served question. Never contains the correct answer or explanation.',
        properties: {
          questionId: { type: 'string', format: 'uuid' }, sequence: { type: 'integer' }, questionText: { type: 'string' }, marks: { type: 'number' },
          options: { type: 'array', items: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, label: { type: 'string', example: 'A' }, optionText: { type: 'string' } } } },
        },
      },
      SaveAnswer: {
        type: 'object',
        required: ['questionId'],
        properties: { questionId: { type: 'string', format: 'uuid' }, selectedOptionId: { type: 'string', format: 'uuid', nullable: true }, markedForReview: { type: 'boolean' } },
      },
      Result: {
        type: 'object',
        properties: {
          assessmentName: { type: 'string' }, productName: { type: 'string' }, marksObtained: { type: 'number', example: 21 }, totalMarks: { type: 'number', example: 25 },
          percentage: { type: 'number', example: 84 }, result: { type: 'string', enum: ['PASS', 'FAIL'] }, correctAnswers: { type: 'integer' }, incorrectAnswers: { type: 'integer' },
          unansweredQuestions: { type: 'integer' }, timeTakenSeconds: { type: 'integer' }, passingPercentage: { type: 'number' }, attemptNumber: { type: 'integer' },
          topicBreakdown: { type: 'array', items: { type: 'object', properties: { topicName: { type: 'string' }, percentage: { type: 'number' } } } },
          review: { type: 'array', description: 'Present only when correct answers are visible', items: { type: 'object' } },
        },
      },
    },
  },
  paths: {
    // ---------------- Authentication ----------------
    '/api/auth/login': { post: { ...op('Authentication', 'Log in with Employee ID or Email', { body: ref('LoginRequest') }), security: [] } },
    '/api/auth/refresh': { post: { ...op('Authentication', 'Rotate the refresh token (cookie) and get a new access token'), security: [] } },
    '/api/auth/logout': { post: { ...op('Authentication', 'Log out (revokes the refresh token)'), security: [] } },
    '/api/auth/me': { get: op('Authentication', 'Current user profile and permissions') },
    '/api/auth/forgot-password': { post: { ...op('Authentication', 'Request a password reset', { body: { type: 'object', properties: { identifier: { type: 'string' } } } }), security: [] } },
    '/api/auth/reset-password': {
      post: { ...op('Authentication', 'Reset password with a reset token', { body: { type: 'object', properties: { token: { type: 'string' }, newPassword: { type: 'string' } } } }), security: [] },
    },
    '/api/auth/change-password': { post: op('Authentication', 'Change own password', { body: { type: 'object', properties: { currentPassword: { type: 'string' }, newPassword: { type: 'string' } } } }) },

    // ---------------- Users & roles ----------------
    '/api/users': {
      get: op('Users', 'List users', { params: [...pageParams, q('roleCode'), q('department'), q('team'), q('location'), q('status')], response: okPage('Users', ref('User')), permission: 'user:read' }),
      post: op('Users', 'Create user', { body: ref('UserInput'), permission: 'user:write', description: 'If no password is given a temporary one is generated and returned once.' }),
    },
    '/api/users/{id}': {
      get: op('Users', 'Get user', { params: [idParam()], response: ok('User', ref('User')), permission: 'user:read' }),
      put: op('Users', 'Update user', { params: [idParam()], body: ref('UserInput'), permission: 'user:write' }),
      delete: op('Users', 'Soft-delete user', { params: [idParam()], permission: 'user:write' }),
    },
    '/api/users/{id}/status': { patch: op('Users', 'Enable / disable user', { params: [idParam()], body: { type: 'object', properties: { status: { type: 'string', enum: ['ACTIVE', 'INACTIVE'] } } }, permission: 'user:write' }) },
    '/api/users/{id}/reset-password': { post: op('Users', 'Reset a user password (admin)', { params: [idParam()], permission: 'user:write' }) },
    '/api/users/bulk/template': { get: op('Users', 'Download bulk user upload template (CSV)', { permission: 'user:write' }) },
    '/api/users/bulk/preview': {
      post: {
        ...op('Users', 'Validate a bulk user file (CSV/XLSX) without saving', { permission: 'user:write' }),
        requestBody: { content: { 'multipart/form-data': { schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } } } },
      },
    },
    '/api/users/bulk/confirm': { post: op('Users', 'Create users from validated rows', { body: { type: 'object', properties: { rows: { type: 'array', items: { type: 'object' } } } }, permission: 'user:write' }) },
    '/api/roles': { get: op('Roles', 'List roles with permissions', { permission: 'role:read' }) },
    '/api/roles/permissions': { get: op('Roles', 'List all permissions', { permission: 'role:read' }) },
    '/api/roles/{id}/permissions': { put: op('Roles', 'Replace role permissions', { params: [idParam()], body: { type: 'object', properties: { permissions: { type: 'array', items: { type: 'string' } } } }, permission: 'role:write' }) },

    // ---------------- Products & topics ----------------
    '/api/products': {
      get: op('Products', 'List products', { params: [...pageParams, q('status'), q('category')], response: okPage('Products', ref('Product')), permission: 'product:read' }),
      post: op('Products', 'Create product', { body: ref('ProductInput'), permission: 'product:write' }),
    },
    '/api/products/options': { get: op('Products', 'Products for dropdowns') },
    '/api/products/{id}': {
      get: op('Products', 'Product details', { params: [idParam()], permission: 'product:read' }),
      put: op('Products', 'Update product', { params: [idParam()], body: ref('ProductInput'), permission: 'product:write' }),
    },
    '/api/products/{id}/status': { patch: op('Products', 'Activate / deactivate product', { params: [idParam()], body: { type: 'object', properties: { status: { type: 'string', enum: ['ACTIVE', 'INACTIVE'] } } }, permission: 'product:write' }) },
    '/api/topics': {
      get: op('Topics', 'Topic tree for a product', { params: [{ ...q('productId', { type: 'string', format: 'uuid' }), required: true }] }),
      post: op('Topics', 'Create topic or subtopic (set parentId)', { body: ref('TopicInput'), permission: 'product:write' }),
    },
    '/api/topics/{id}': {
      put: op('Topics', 'Update topic', { params: [idParam()], permission: 'product:write' }),
      delete: op('Topics', 'Delete topic (only when unused)', { params: [idParam()], permission: 'product:write' }),
    },

    // ---------------- Questions ----------------
    '/api/questions': {
      get: op('Questions', 'Search the question bank', {
        params: [...pageParams, q('productId'), q('topicId'), q('subTopicId'), q('difficultyLevel'), q('status'), q('createdById')],
        permission: 'question:read',
      }),
      post: op('Questions', 'Add question', { body: ref('QuestionInput'), permission: 'question:write' }),
    },
    '/api/questions/{id}': {
      get: op('Questions', 'Question with options (admin view)', { params: [idParam()], permission: 'question:read' }),
      put: op('Questions', 'Edit question (options are replaced; attempts keep their snapshot)', { params: [idParam()], body: ref('QuestionInput'), permission: 'question:write' }),
      delete: op('Questions', 'Soft-delete question', { params: [idParam()], permission: 'question:write' }),
    },
    '/api/questions/{id}/status': { patch: op('Questions', 'Change question status', { params: [idParam()], permission: 'question:write' }) },
    '/api/questions/{id}/attachments': {
      get: op('Questions', 'List attachments (question_attachments)', { params: [idParam()], permission: 'question:read' }),
      post: op('Questions', 'Add attachment', { params: [idParam()], body: ref('AttachmentInput'), permission: 'question:write' }),
    },
    '/api/questions/{id}/attachments/{attachmentId}': {
      put: op('Questions', 'Update attachment', { params: [idParam(), idParam('attachmentId')], body: ref('AttachmentInput'), permission: 'question:write' }),
      delete: op('Questions', 'Remove attachment', { params: [idParam(), idParam('attachmentId')], permission: 'question:write' }),
    },
    '/api/questions/bulk/template': { get: op('Questions', 'Download bulk upload template (CSV)', { permission: 'question:write' }) },
    '/api/questions/bulk/preview': {
      post: {
        ...op('Questions', 'Validate a CSV/XLSX question file: errors, warnings, duplicates', { permission: 'question:write' }),
        requestBody: { content: { 'multipart/form-data': { schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } } } },
      },
    },
    '/api/questions/bulk/confirm': {
      post: op('Questions', 'Store valid rows (server re-validates)', { body: { type: 'object', properties: { rows: { type: 'array', items: { type: 'object' } }, status: { type: 'string', enum: ['DRAFT', 'ACTIVE'] } } }, permission: 'question:write' }),
    },

    // ---------------- Assessments ----------------
    '/api/assessments': {
      get: op('Assessments', 'List assessments', { params: [...pageParams, q('productId'), q('status'), q('selectionMode')], permission: 'assessment:read' }),
      post: op('Assessments', 'Create assessment (draft)', { body: ref('AssessmentInput'), permission: 'assessment:write' }),
    },
    '/api/assessments/preview-rules': { post: op('Assessments', 'Check dynamic rules against the question bank', { permission: 'assessment:write' }) },
    '/api/assessments/{id}': {
      get: op('Assessments', 'Assessment details', { params: [idParam()], permission: 'assessment:read' }),
      put: op('Assessments', 'Update assessment (full in DRAFT; name/description/instructions/end date after publishing)', { params: [idParam()], body: ref('AssessmentInput'), permission: 'assessment:write' }),
      delete: op('Assessments', 'Delete draft assessment', { params: [idParam()], permission: 'assessment:write' }),
    },
    '/api/assessments/{id}/validate': { get: op('Assessments', 'Publish readiness check', { params: [idParam()], permission: 'assessment:read' }) },
    '/api/assessments/{id}/publish': { post: op('Assessments', 'Publish (freezes configuration)', { params: [idParam()], permission: 'assessment:publish' }) },
    '/api/assessments/{id}/status': { patch: op('Assessments', 'Deactivate / reactivate', { params: [idParam()], permission: 'assessment:publish' }) },
    '/api/assessments/{id}/difficulty-distribution': {
      get: op('Assessments', 'Difficulty distribution rows (assessment_difficulty_distribution)', { params: [idParam()], permission: 'assessment:read' }),
      put: op('Assessments', 'Replace difficulty distribution (draft, dynamic only; must equal the rules total)', {
        params: [idParam()],
        body: { type: 'object', properties: { distribution: { type: 'object', nullable: true, properties: { EASY: { type: 'integer' }, MEDIUM: { type: 'integer' }, HARD: { type: 'integer' } } } } },
        permission: 'assessment:write',
      }),
    },
    '/api/assessments/{id}/versions': {
      get: op('Assessments', 'Published versions (assessment_versions): one per publish or operational change', { params: [idParam()], permission: 'assessment:read' }),
    },
    '/api/assessments/{id}/versions/{versionId}': {
      get: op('Assessments', 'Version detail with frozen questions, rules and distribution', { params: [idParam(), idParam('versionId')], permission: 'assessment:read' }),
    },
    '/api/assessments/{id}/clone': { post: op('Assessments', 'Clone as a new draft version', { params: [idParam()], permission: 'assessment:write' }) },
    '/api/assessments/{assessmentId}/start': {
      post: op('Attempts', 'Start (or resume) an attempt', {
        params: [idParam('assessmentId')],
        description: 'Checks assignment, availability window, due date, max attempts and reattempt policy, then snapshots the question set. The server-side timer starts now.',
      }),
    },
    '/api/assignments': {
      get: op('Assignments', 'List assignments', { params: [...pageParams, q('assessmentId'), q('assignmentType'), q('status')], permission: 'assignment:read' }),
      post: op('Assignments', 'Assign an assessment to users, teams, departments, roles, product groups or locations', { body: ref('AssignmentInput'), permission: 'assignment:write' }),
    },
    '/api/assignments/{id}': {
      patch: op('Assignments', 'Change due date', { params: [idParam()], permission: 'assignment:write' }),
      delete: op('Assignments', 'Cancel assignment', { params: [idParam()], permission: 'assignment:write' }),
    },

    // ---------------- Learner ----------------
    '/api/user/assessments': { get: op('Learner', 'My assigned assessments with status and available action') },
    '/api/user/dashboard': { get: op('Learner', 'My dashboard summary cards and assessment table') },
    '/api/user/assessments/{assessmentId}/instructions': { get: op('Learner', 'Instructions shown before starting', { params: [idParam('assessmentId')] }) },
    '/api/user/attempts': { get: op('Learner', 'My attempt history', { params: pageParams }) },
    '/api/user/certificates': { get: op('Learner', 'My certificates') },

    // ---------------- Attempts ----------------
    '/api/attempts/{attemptId}/questions': {
      get: op('Attempts', 'Questions, saved answers and server timer (no correct answers)', {
        params: [idParam('attemptId')],
        response: ok('Attempt', { type: 'object', properties: { attempt: { type: 'object' }, questions: { type: 'array', items: ref('AttemptQuestion') }, answers: { type: 'array' } } }),
      }),
    },
    '/api/attempts/{attemptId}/answers': { post: op('Attempts', 'Save one answer immediately', { params: [idParam('attemptId')], body: ref('SaveAnswer') }) },
    '/api/attempts/{attemptId}/submit': { post: op('Attempts', 'Submit the attempt (evaluated server-side, only once)', { params: [idParam('attemptId')] }) },
    '/api/attempts/{attemptId}/result': { get: op('Attempts', 'Attempt result', { params: [idParam('attemptId')], response: ok('Result', ref('Result')) }) },
    '/api/results/{attemptId}': { get: op('Reports', 'Attempt result (reviewer view)', { params: [idParam('attemptId')], permission: 'report:read' }) },
    '/api/results/{attemptId}/snapshot': {
      get: op('Reports', 'Exact attempt snapshot: version, questions, option rows (attempt_question_options) and answers', { params: [idParam('attemptId')], permission: 'report:read' }),
    },

    // ---------------- Reports & dashboard ----------------
    '/api/dashboard/admin': { get: op('Dashboard', 'Admin dashboard cards and charts', { params: [q('productId'), q('from'), q('to')], permission: 'dashboard:view' }) },
    '/api/reports/results': { get: op('Reports', 'Completed attempts (search/filter/sort/paginate)', { params: [...pageParams, q('productId'), q('assessmentId'), q('department'), q('result'), q('from'), q('to')], permission: 'report:read' }) },
    '/api/reports/assessments/{id}': { get: op('Reports', 'Assessment report', { params: [idParam()], permission: 'report:read' }) },
    '/api/reports/users/{id}': { get: op('Reports', 'User performance report', { params: [idParam()], permission: 'report:read' }) },
    '/api/reports/pending': { get: op('Reports', 'Pending assessments', { params: [...pageParams, q('productId'), q('assessmentId'), q('overdueOnly')], permission: 'report:read' }) },
    '/api/reports/knowledge-gap': { get: op('Reports', 'Topic-wise knowledge-gap analysis', { params: [q('productId'), q('assessmentId'), q('department'), q('team'), q('userId')], permission: 'report:read' }) },
    '/api/reports/question-analytics': { get: op('Reports', 'Question effectiveness with review flags', { params: [...pageParams, q('productId'), q('topicId'), q('flag')], permission: 'report:read' }) },
    '/api/reports/products': { get: op('Reports', 'Product-wise summary', { permission: 'report:read' }) },
    '/api/reports/export/{type}': {
      get: op('Reports', 'Export report as CSV', {
        params: [
          { name: 'type', in: 'path', required: true, schema: { type: 'string', enum: ['user-results', 'assessment-results', 'product-report', 'knowledge-gap', 'pending-assessments'] } },
          q('format', { type: 'string', enum: ['csv'] }),
          q('assessmentId'),
          q('productId'),
        ],
        permission: 'report:export',
        response: { description: 'CSV file', content: { 'text/csv': { schema: { type: 'string' } } } },
      }),
    },

    // ---------------- Notifications, settings, audit ----------------
    '/api/notifications': { get: op('Notifications', 'My notifications', { params: [...pageParams, q('unreadOnly')] }) },
    '/api/notifications/unread-count': { get: op('Notifications', 'Unread count') },
    '/api/notifications/{id}/read': { patch: op('Notifications', 'Mark as read', { params: [idParam()] }) },
    '/api/notifications/read-all': { patch: op('Notifications', 'Mark all as read') },
    '/api/settings': {
      get: op('Settings', 'Application settings', { permission: 'settings:read' }),
      put: op('Settings', 'Update settings (partial)', { body: { type: 'object', additionalProperties: true }, permission: 'settings:write' }),
    },
    '/api/settings/entries': { get: op('Settings', 'All setting rows (application_settings) with type and default', { permission: 'settings:read' }) },
    '/api/settings/entries/{key}': {
      get: op('Settings', 'One setting row, e.g. passwordPolicy.minLength', { params: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }], permission: 'settings:read' }),
      put: op('Settings', 'Set one setting row (type-checked and validated with its group)', {
        params: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }],
        body: { type: 'object', properties: { value: { oneOf: [{ type: 'number' }, { type: 'boolean' }, { type: 'string' }] } } },
        permission: 'settings:write',
      }),
    },
    '/api/settings/knowledge-gap-bands': {
      get: op('Settings', 'Knowledge-gap bands (knowledge_gap_bands)'),
      post: op('Settings', 'Create band (no overlaps allowed)', { body: ref('BandInput'), permission: 'settings:write' }),
    },
    '/api/settings/knowledge-gap-bands/{id}': {
      put: op('Settings', 'Update band', { params: [idParam()], body: ref('BandInput'), permission: 'settings:write' }),
      delete: op('Settings', 'Delete band (at least one must remain)', { params: [idParam()], permission: 'settings:write' }),
    },
    '/api/audit-logs': { get: op('Audit', 'Audit trail', { params: [...pageParams, q('action'), q('entityType'), q('userId'), q('from'), q('to')], permission: 'audit:read' }) },
    '/api/audit-logs/{id}': { get: op('Audit', 'Audit entry with field-level changes (audit_log_changes)', { params: [idParam()], permission: 'audit:read' }) },
    '/api/health': { get: { ...op('Dashboard', 'Health check'), security: [] } },
  },
};
