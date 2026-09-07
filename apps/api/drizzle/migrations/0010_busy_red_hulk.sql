CREATE TYPE "public"."oven_mount" AS ENUM('trailer', 'built_in');--> statement-breakpoint
CREATE TABLE "trucks" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"oven_mount" "oven_mount" NOT NULL,
	"range_miles" integer NOT NULL,
	"comfort" integer DEFAULT 3 NOT NULL,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "truck_id" text;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "can_drive" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "can_drive_trailer" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_truck_id_trucks_id_fk" FOREIGN KEY ("truck_id") REFERENCES "public"."trucks"("id") ON DELETE no action ON UPDATE no action;