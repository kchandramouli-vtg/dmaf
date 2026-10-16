import xml.etree.ElementTree as ET
from typing import Any, Dict

from pydantic.main import BaseModel


class TemporalInterval(BaseModel):

    data: str = ''
    namespace: Dict[str, str] = {}
    beforeDate: str = ''
    afterDate: str = ''

    def parse(self):
        temporalInterval = ET.fromstring(self.data)
        afterDate = temporalInterval.find('cel-ipre:afterDate', self.namespace)
        beforeDate = temporalInterval.find(
            'cel-ipre:beforeDate', self.namespace)
        if beforeDate is not None:  # DMAF: Element truthiness is len(children)
            self.beforeDate = beforeDate.text
        if afterDate is not None:  # DMAF: Element truthiness is len(children)
            self.afterDate = afterDate.text
        self.namespace = None
        self.data = None
