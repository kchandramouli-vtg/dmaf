import xml.etree.ElementTree as ET
from typing import Any, Dict

from pydantic.main import BaseModel


class Metadata(BaseModel):
    data: str = ''
    namespace: Dict[str, str] = {}
    information: str = ''

    def parse(self):
        metadata = ET.fromstring(self.data)
        self.information = ET.tostring(metadata[0]).decode('ascii')
        self.namespace = None
        self.data = None

    def __str__(self):
        return (self.information)
