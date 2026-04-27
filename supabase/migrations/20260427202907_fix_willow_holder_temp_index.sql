-- Willow (Lego Dream) and Holder (Disneyland Oasis) are dual pool/spa controllers.
-- temp1 maps to the spa setpoint on these panels; pool is temp2.
-- Previously index=1 caused guest temp changes to write to the spa instead of the pool.
UPDATE public.homes
SET iaqualink_temp_sensor_index = 2
WHERE internal_name IN ('Willow','Holder');
