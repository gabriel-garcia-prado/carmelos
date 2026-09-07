CREATE TYPE "public"."confirmation_role" AS ENUM('pizzaiolo', 'crew', 'fire_duty');--> statement-breakpoint
CREATE TYPE "public"."confirmation_status" AS ENUM('pending', 'sent', 'confirmed', 'declined');--> statement-breakpoint
CREATE TYPE "public"."rig" AS ENUM('small_caddy', 'big_caddy', 'pickup', 'bus');--> statement-breakpoint
CREATE TYPE "public"."special_request_type" AS ENUM('gluten_free', 'halal', 'no_pork', 'vegetarian', 'vegan', 'dairy_free', 'paneer', 'spicy');--> statement-breakpoint
CREATE TABLE "event_confirmations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"role" "confirmation_role" NOT NULL,
	"message_body" text NOT NULL,
	"status" "confirmation_status" DEFAULT 'pending' NOT NULL,
	"sent_at" timestamp,
	"confirmed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_special_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"request_type" "special_request_type" NOT NULL,
	"headcount" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rig" "rig" NOT NULL,
	"first_pizza_time" timestamp NOT NULL,
	"headcount" integer NOT NULL,
	"address" text NOT NULL,
	"drive_minutes" integer NOT NULL,
	"drive_minutes_back_to_shop" integer,
	"service_duration_minutes" integer DEFAULT 120 NOT NULL,
	"setup_minutes_override" integer,
	"rack_count" integer DEFAULT 0 NOT NULL,
	"pizzaiolo_id" uuid NOT NULL,
	"crew_member_id" uuid NOT NULL,
	"fire_duty_override_person_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "people" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"phone" text NOT NULL,
	"rack_rate_override_per30_min" integer,
	"minutes_before_departure_override" integer,
	"home_base_address" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" text PRIMARY KEY DEFAULT 'global' NOT NULL,
	"oven_to_temp_minutes" integer DEFAULT 240 NOT NULL,
	"fire_before_load_minutes" integer DEFAULT 120 NOT NULL,
	"setup_aimed_minutes" integer DEFAULT 60 NOT NULL,
	"setup_floor_minutes" integer DEFAULT 30 NOT NULL,
	"break_down_minutes" integer DEFAULT 30 NOT NULL,
	"load_minutes" integer DEFAULT 10 NOT NULL,
	"dough_thaw_min_minutes" integer DEFAULT 720 NOT NULL,
	"dough_thaw_max_minutes" integer DEFAULT 960 NOT NULL,
	"service_radius_minutes" integer DEFAULT 120 NOT NULL,
	"spare_pizzas_per_event" integer DEFAULT 25 NOT NULL,
	"cheese_bags_per_dough" integer DEFAULT 25 NOT NULL,
	"sauce_per_pizzas" integer DEFAULT 35 NOT NULL,
	"tray_size" integer DEFAULT 25 NOT NULL,
	"default_rack_rate_per30_min" integer DEFAULT 20 NOT NULL,
	"default_minutes_before_departure" integer DEFAULT 15 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "event_confirmations" ADD CONSTRAINT "event_confirmations_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_confirmations" ADD CONSTRAINT "event_confirmations_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_special_requests" ADD CONSTRAINT "event_special_requests_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_pizzaiolo_id_people_id_fk" FOREIGN KEY ("pizzaiolo_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_crew_member_id_people_id_fk" FOREIGN KEY ("crew_member_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_fire_duty_override_person_id_people_id_fk" FOREIGN KEY ("fire_duty_override_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;