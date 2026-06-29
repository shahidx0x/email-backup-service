import { z } from 'zod';
export const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid object id');
export const emailAddressSchema = z.object({ name: z.string().optional(), address: z.string().email() });
