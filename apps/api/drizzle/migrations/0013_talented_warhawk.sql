CREATE TYPE "public"."assignment_role" AS ENUM('pizzaiolo', 'stick', 'cutter');--> statement-breakpoint
ALTER TYPE "public"."confirmation_role" ADD VALUE 'cutter' BEFORE 'fire_duty';--> statement-breakpoint
CREATE TABLE "event_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"role" "assignment_role" NOT NULL,
	"meets_on_site" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "events" DROP CONSTRAINT "events_pizzaiolo_id_people_id_fk";
--> statement-breakpoint
ALTER TABLE "events" DROP CONSTRAINT "events_crew_member_id_people_id_fk";
--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "can_stick" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "event_assignments" ADD CONSTRAINT "event_assignments_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_assignments" ADD CONSTRAINT "event_assignments_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Carry every existing pairing across before the columns holding it go.
-- meets_on_site defaults false, which is what these all were: both people
-- rode out with the rig.
INSERT INTO "event_assignments" ("event_id", "person_id", "role")
	SELECT "id", "pizzaiolo_id", 'pizzaiolo' FROM "events";--> statement-breakpoint
INSERT INTO "event_assignments" ("event_id", "person_id", "role")
	SELECT "id", "crew_member_id", 'stick' FROM "events";--> statement-breakpoint
ALTER TABLE "events" DROP COLUMN "pizzaiolo_id";--> statement-breakpoint
ALTER TABLE "events" DROP COLUMN "crew_member_id";