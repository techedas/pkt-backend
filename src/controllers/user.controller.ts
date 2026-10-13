import type { Request, Response } from 'express';
import { ctxOf } from '../middlewares/auth';
import { userService } from '../services/user.service';
import { AppError } from '../utils/errors';
import { created, ok, paginated } from '../utils/response';
import { csvTemplate, parseSpreadsheet } from '../utils/spreadsheet';

const USER_TEMPLATE_HEADERS = [
  'Employee ID', 'First Name', 'Last Name', 'Email', 'Mobile', 'Department', 'Designation',
  'Team', 'Product Group', 'Location', 'Role', 'Manager Employee ID', 'Password',
];

export const userController = {
  async list(req: Request, res: Response) {
    const { rows, pagination } = await userService.list(ctxOf(req), req.query as never);
    return paginated(res, rows, pagination);
  },

  async get(req: Request, res: Response) {
    return ok(res, await userService.get(ctxOf(req), req.params.id));
  },

  async create(req: Request, res: Response) {
    return created(res, await userService.create(ctxOf(req), req.body), 'User created successfully');
  },

  async update(req: Request, res: Response) {
    return ok(res, await userService.update(ctxOf(req), req.params.id, req.body), 'User updated successfully');
  },

  async setStatus(req: Request, res: Response) {
    const user = await userService.setStatus(ctxOf(req), req.params.id, req.body.status);
    return ok(res, user, user.status === 'ACTIVE' ? 'User enabled' : 'User disabled');
  },

  async remove(req: Request, res: Response) {
    await userService.remove(ctxOf(req), req.params.id);
    return ok(res, null, 'User deleted');
  },

  async resetPassword(req: Request, res: Response) {
    return ok(res, await userService.adminResetPassword(ctxOf(req), req.params.id, req.body?.newPassword), 'Password reset successfully');
  },

  async lookups(_req: Request, res: Response) {
    return ok(res, await userService.lookups());
  },

  async picker(req: Request, res: Response) {
    return ok(res, await userService.searchForPicker(ctxOf(req), (req.query.search as string) || undefined));
  },

  async bulkTemplate(_req: Request, res: Response) {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="pkt_user_upload_template.csv"');
    res.send(
      csvTemplate(USER_TEMPLATE_HEADERS, [
        ['EMP1001', 'Asha', 'Rao', 'asha.rao@example.com', '9876543210', 'Support', 'Agent', 'Team A', 'Contact Center', 'Mumbai', 'USER', 'MGR001', ''],
      ]),
    );
  },

  async bulkPreview(req: Request, res: Response) {
    if (!req.file) throw AppError.badRequest('Please attach a .csv or .xlsx file.', 'FILE_REQUIRED');
    const rows = await parseSpreadsheet(req.file);
    return ok(res, await userService.bulkPreview(rows));
  },

  async bulkConfirm(req: Request, res: Response) {
    const result = await userService.bulkConfirm(ctxOf(req), req.body.rows);
    return ok(res, result, `${result.summary.created} user(s) created`);
  },
};
