-- PostgreSQL bootstrap for deploy/compose.roles.yaml. Runs only when the data volume is empty.
-- POSTGRES_DB creates platform_control; the scheduler needs its own database.
CREATE DATABASE scheduler OWNER platform;
