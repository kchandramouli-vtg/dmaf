
import xml.etree.ElementTree as ET
from typing import Dict

from pydantic.main import BaseModel


class ServiceAccessPolicyType(BaseModel):

    data: str = ''
    namespace: Dict[str, str] = {}
    mod: str = ''

    def parse(self):
        ServiceAccessPolicyType = ET.fromstring(self.data)
        mod = ServiceAccessPolicyType.find('cel-ipre:ModType', self.namespace)
        if mod is not None:  # DMAF: Element truthiness is len(children)
            self.mod = mod.text
        self.namespace = None
        self.data = None
