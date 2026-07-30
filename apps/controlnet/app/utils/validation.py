from flask import request, jsonify
from functools import wraps
from marshmallow import ValidationError
from .logging import get_logger

logger = get_logger(__name__)

def validate_schema(schema_class):
  def decorator(f):
      @wraps(f)
      def decorated_function(*args, **kwargs):
          schema = schema_class()
          try:
              data = request.get_json()
              if not data:
                  logger.error("Invalid JSON data")
                  return jsonify({"error": "Invalid JSON data"}), 400
              
              validated_data = schema.load(data)
              
              return f(validated_data, *args, **kwargs)
              
          except ValidationError as ve:
              logger.error(f"Schema validation error: {ve.messages}")
              return jsonify({"error": ve.messages}), 400
          except Exception as e:
              logger.error(f"Error during request validation: {str(e)}")
              return jsonify({"error": f"Invalid request: {str(e)}"}), 400
      return decorated_function
  return decorator