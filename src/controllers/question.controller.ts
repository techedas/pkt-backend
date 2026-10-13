import type { Request, Response } from 'express';
import { ctxOf } from '../middlewares/auth';
import { questionService } from '../services/question.service';
import { AppError } from '../utils/errors';
import { created, ok, paginated } from '../utils/response';
import { csvTemplate, parseSpreadsheet } from '../utils/spreadsheet';

export const QUESTION_TEMPLATE_HEADERS = [
  'Product Code', 'Topic', 'Subtopic', 'Question', 'Option A', 'Option B', 'Option C', 'Option D',
  'Option E', 'Option F', 'Correct Answer', 'Difficulty', 'Marks', 'Negative Marks', 'Explanation',
];

export const questionController = {
  async list(req: Request, res: Response) {
    const { rows, pagination } = await questionService.list(ctxOf(req), req.query as never);
    return paginated(res, rows, pagination);
  },
  async get(req: Request, res: Response) {
    return ok(res, await questionService.get(ctxOf(req), req.params.id));
  },
  async create(req: Request, res: Response) {
    return created(res, await questionService.create(ctxOf(req), req.body), 'Question added successfully');
  },
  async update(req: Request, res: Response) {
    return ok(res, await questionService.update(ctxOf(req), req.params.id, req.body), 'Question updated successfully');
  },
  async setStatus(req: Request, res: Response) {
    return ok(res, await questionService.setStatus(ctxOf(req), req.params.id, req.body.status), 'Question status updated');
  },
  async remove(req: Request, res: Response) {
    await questionService.remove(ctxOf(req), req.params.id);
    return ok(res, null, 'Question deleted');
  },
  async listAttachments(req: Request, res: Response) {
    return ok(res, await questionService.listAttachments(ctxOf(req), req.params.id));
  },
  async addAttachment(req: Request, res: Response) {
    return created(res, await questionService.addAttachment(ctxOf(req), req.params.id, req.body), 'Attachment added');
  },
  async updateAttachment(req: Request, res: Response) {
    return ok(res, await questionService.updateAttachment(ctxOf(req), req.params.id, req.params.attachmentId, req.body), 'Attachment updated');
  },
  async removeAttachment(req: Request, res: Response) {
    await questionService.removeAttachment(ctxOf(req), req.params.id, req.params.attachmentId);
    return ok(res, null, 'Attachment removed');
  },
  async creators(req: Request, res: Response) {
    return ok(res, await questionService.creators(ctxOf(req)));
  },
  async template(_req: Request, res: Response) {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="pkt_question_upload_template.csv"');
    res.send(
      csvTemplate(QUESTION_TEMPLATE_HEADERS, [
        [
          'VAANI', 'Dialing', 'Predictive', 'Which dialing mode predicts agent availability?', 'Manual', 'Preview',
          'Predictive', 'Progressive', '', '', 'C', 'EASY', '1', '0',
          'Predictive dialing automatically predicts agent availability and initiates calls accordingly.',
        ],
      ]),
    );
  },
  async bulkPreview(req: Request, res: Response) {
    if (!req.file) throw AppError.badRequest('Please attach a .csv or .xlsx file.', 'FILE_REQUIRED');
    const rows = await parseSpreadsheet(req.file);
    return ok(res, await questionService.bulkPreview(ctxOf(req), rows));
  },
  async bulkConfirm(req: Request, res: Response) {
    const result = await questionService.bulkConfirm(ctxOf(req), req.body.rows, req.body.status);
    return ok(res, result, `${result.created} question(s) uploaded`);
  },
};
