"""Чтение игровых .model-файлов для 3D-превью.

Ядро парсера (binary_io, constraints, coord_space, skeleton,
model_reader, material_format) перенесено без изменений логики из
Blender-плагина автора (TerminatorBlenderProject), где формат уже
разобран и проверен round-trip в игре.
"""

from .model_reader import ParsedModel, read_model

__all__ = ["ParsedModel", "read_model"]
