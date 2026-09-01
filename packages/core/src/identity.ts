import { z } from "zod";

export const PrincipalRoleSchema = z.enum(["owner", "operator", "viewer"]);

export const PrincipalBindingSchema = z.object({
  principalId: z.string().min(1),
  slackUserIds: z.array(z.string().min(1)),
  telegramUserIds: z.array(z.string().min(1)),
  telegramChatIds: z.array(z.string().min(1)),
  tailscaleLoginNames: z.array(z.string().min(1)),
  roles: z.array(PrincipalRoleSchema)
}).strict();

export type PrincipalRole = z.infer<typeof PrincipalRoleSchema>;
export type PrincipalBinding = z.infer<typeof PrincipalBindingSchema>;
