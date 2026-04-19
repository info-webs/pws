// 1. Import utilities from `astro:content`
import { z, defineCollection } from "astro:content";

// 2. Define your collection(s)
const blogCollection = defineCollection({
  schema: ({ image }) =>
    z.object({
      draft: z.boolean(),
      title: z.string(),
      excerpt: z.string(),
      image: image(),
      publishDate: z.string().transform((str) => new Date(str)),
      author: z.string().default("bSaaS Team"),
      category: z.string(),
      tags: z.array(z.string()),
    }),
});

const teamCollection = defineCollection({
  schema: ({ image }) =>
    z.object({
      draft: z.boolean().optional(),
      name: z.string(),
      title: z.string(),
      avatar: z.object({
        src: image(),
        alt: z.string(),
      }),
      social: z.optional(
        z.object({
          twitter: z.string().url().optional(),
          linkedin: z.string().url().optional(),
          facebook: z.string().url().optional(),
        }),
      ),
    }),
});

// 3. Export a single `collections` object to register your collection(s)
//    This key should match your collection directory name in "src/content"
export const collections = {
  blog: blogCollection,
  team: teamCollection,
};
