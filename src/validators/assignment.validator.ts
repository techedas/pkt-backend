import { z } from 'zod';
import { pageQuerySchema } from '../utils/pagination';
import { optionalDate, uuid } from './common';

const assignmentType = z.enum(['USER', 'TEAM', 'DEPARTMENT', 'ROLE', 'PRODUCT_GROUP', 'LOCATION']);

export const createAssignmentSchema = z.object({
  assessmentId: uuid,
  targets: z
    .array(z.object({ assignmentType, assignmentReference: z.string().trim().min(1).max(150) }))
    .min(1)
    .max(1000),
  dueDate: optionalDate,
  notify: z.boolean().default(true),
});

export const updateAssignmentSchema = z.object({
  dueDate: optionalDate,
});

export const listAssignmentsSchema = pageQuerySchema.extend({
  assessmentId: uuid.optional(),
  assignmentType: assignmentType.optional(),
  status: z.enum(['ACTIVE', 'CANCELLED', 'INACTIVE']).optional(),
});
