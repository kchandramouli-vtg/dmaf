import xml.etree.ElementTree as ET
from typing import Dict

from pydantic.main import BaseModel


class DeviceType(BaseModel):

    data: str = ''
    namespace: Dict[str, str] = {}
    DeviceT: str = ''

    def parse(self):
        DeviceType = ET.fromstring(self.data)
        DeviceT = DeviceType.find('cel-ipre:DeviceT', self.namespace)
        if DeviceT is not None:  # DMAF: Element truthiness is len(children)
            self.DeviceT = DeviceT.text
        self.namespace = None
        self.data = None
