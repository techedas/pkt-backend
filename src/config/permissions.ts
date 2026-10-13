/**
 * Permission catalogue and default role -> permission mapping.
 * Permissions are stored in the database (seeded from here) so roles can be
 * re-configured at runtime through the Roles API.
 */
export const PERMISSIONS = {
  DASHBOARD_VIEW: 'dashboard:view',
  PRODUCT_READ: 'product:read',
  PRODUCT_WRITE: 'product:write',
  QUESTION_READ: 'question:read',
  QUESTION_WRITE: 'question:write',
  ASSESSMENT_READ: 'assessment:read',
  ASSESSMENT_WRITE: 'assessment:write',
  ASSESSMENT_PUBLISH: 'assessment:publish',
  ASSIGNMENT_READ: 'assignment:read',
  ASSIGNMENT_WRITE: 'assignment:write',
  USER_READ: 'user:read',
  USER_WRITE: 'user:write',
  ROLE_READ: 'role:read',
  ROLE_WRITE: 'role:write',
  REPORT_READ: 'report:read',
  REPORT_EXPORT: 'report:export',
  SETTINGS_READ: 'settings:read',
  SETTINGS_WRITE: 'settings:write',
  AUDIT_READ: 'audit:read',
} as const;

export type PermissionCode = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const PERMISSION_DESCRIPTIONS: Record<PermissionCode, string> = {
  'dashboard:view': 'View the admin dashboard',
  'product:read': 'View products and topics',
  'product:write': 'Create and edit products and topics',
  'question:read': 'View the question bank',
  'question:write': 'Create, edit, upload and disable questions',
  'assessment:read': 'View assessments',
  'assessment:write': 'Create and edit assessments',
  'assessment:publish': 'Publish and deactivate assessments',
  'assignment:read': 'View assessment assignments',
  'assignment:write': 'Assign assessments to users and groups',
  'user:read': 'View users',
  'user:write': 'Create, edit and disable users',
  'role:read': 'View roles and permissions',
  'role:write': 'Edit role permissions',
  'report:read': 'View reports and analytics',
  'report:export': 'Export reports',
  'settings:read': 'View application settings',
  'settings:write': 'Change application settings',
  'audit:read': 'View audit logs',
};

export const ROLE_CODES = {
  SUPER_ADMIN: 'SUPER_ADMIN',
  PRODUCT_ADMIN: 'PRODUCT_ADMIN',
  TRAINER: 'TRAINER',
  MANAGER: 'MANAGER',
  USER: 'USER',
  AUDITOR: 'AUDITOR',
} as const;

export type RoleCode = (typeof ROLE_CODES)[keyof typeof ROLE_CODES];

const P = PERMISSIONS;

export const DEFAULT_ROLES: Array<{
  code: RoleCode;
  name: string;
  description: string;
  permissions: PermissionCode[];
}> = [
  {
    code: 'SUPER_ADMIN',
    name: 'Super Admin',
    description: 'Full access to every module and setting',
    permissions: Object.values(P),
  },
  {
    code: 'PRODUCT_ADMIN',
    name: 'Product Admin',
    description: 'Manages assigned products, their questions, assessments and reports',
    permissions: [
      P.DASHBOARD_VIEW, P.PRODUCT_READ, P.PRODUCT_WRITE, P.QUESTION_READ, P.QUESTION_WRITE,
      P.ASSESSMENT_READ, P.ASSESSMENT_WRITE, P.ASSESSMENT_PUBLISH, P.ASSIGNMENT_READ,
      P.ASSIGNMENT_WRITE, P.USER_READ, P.REPORT_READ, P.REPORT_EXPORT,
    ],
  },
  {
    code: 'TRAINER',
    name: 'Trainer',
    description: 'Maintains questions, builds assessments and reviews results',
    permissions: [
      P.DASHBOARD_VIEW, P.PRODUCT_READ, P.QUESTION_READ, P.QUESTION_WRITE, P.ASSESSMENT_READ,
      P.ASSESSMENT_WRITE, P.REPORT_READ,
    ],
  },
  {
    code: 'MANAGER',
    name: 'Manager',
    description: 'Assigns assessments to the team and tracks team results and knowledge gaps',
    permissions: [
      P.DASHBOARD_VIEW, P.PRODUCT_READ, P.ASSESSMENT_READ, P.ASSIGNMENT_READ, P.ASSIGNMENT_WRITE,
      P.USER_READ, P.REPORT_READ, P.REPORT_EXPORT,
    ],
  },
  {
    code: 'USER',
    name: 'User',
    description: 'Takes assigned assessments and views own results',
    permissions: [],
  },
  {
    code: 'AUDITOR',
    name: 'Auditor',
    description: 'Read-only access to assessments, attempts, scores, reports and audit logs',
    permissions: [
      P.DASHBOARD_VIEW, P.PRODUCT_READ, P.QUESTION_READ, P.ASSESSMENT_READ, P.ASSIGNMENT_READ,
      P.USER_READ, P.REPORT_READ, P.REPORT_EXPORT, P.AUDIT_READ,
    ],
  },
];
