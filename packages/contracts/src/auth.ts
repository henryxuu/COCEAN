import { z } from "zod";

export const userRoleSchema = z.enum(["ADMIN", "MEMBER"]);
export type UserRole = z.infer<typeof userRoleSchema>;

export const authUserSchema = z.object({
  id: z.string(),
  username: z.string(),
  displayName: z.string(),
  role: userRoleSchema,
  enabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastLoginAt: z.string().nullable(),
});
export type AuthUser = z.infer<typeof authUserSchema>;

export const authSessionSchema = z.object({
  user: authUserSchema,
  expiresAt: z.string(),
});
export type AuthSession = z.infer<typeof authSessionSchema>;
