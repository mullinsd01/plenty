import { z } from "zod";

export const emailSchema = z
  .string({ error: "Enter your email address." })
  .trim()
  .toLowerCase()
  .min(3, "Enter your email address.")
  .max(254, "That email address is too long.")
  .pipe(z.email({ error: "That doesn't look like an email address." }));

export const passwordSchema = z
  .string({ error: "Choose a password." })
  .min(8, "Use at least 8 characters.")
  .max(200, "That password is too long.");

export const nameSchema = z
  .string({ error: "Tell us your name." })
  .trim()
  .min(1, "Tell us your name.")
  .max(60, "Keep your name under 60 characters.");

export const signUpSchema = z.object({
  name: nameSchema,
  email: emailSchema,
  password: passwordSchema,
});

/** The sign-up form adds an explicit confirmation; service-level sign-up (tests, seeds) doesn't carry it. */
export const signUpFormSchema = signUpSchema.extend({
  terms: z.literal("on", { error: "Tick this box to confirm you're 18 or over and agree to the Terms and Privacy Policy." }),
});

export const signInSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Enter your password.").max(200),
});

export const forgotPasswordSchema = z.object({ email: emailSchema });

export const resetPasswordSchema = z
  .object({
    token: z.string().min(20, "This reset link is invalid.").max(200),
    password: passwordSchema,
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, { message: "Passwords don't match.", path: ["confirm"] });

export const changePasswordSchema = z
  .object({
    current: z.string().min(1, "Enter your current password."),
    password: passwordSchema,
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, { message: "Passwords don't match.", path: ["confirm"] });
